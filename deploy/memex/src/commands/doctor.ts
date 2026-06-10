/**
 * `memex doctor` — self-diagnostics. Prints a structured report and
 * exits 0 on healthy / 1 on any failure. Intended to run in seconds —
 * no embedding calls or full sweeps. Suitable for cron probes and CI
 * smoke tests.
 *
 * Checks:
 *   - config file exists and parses
 *   - PGLite opens and migrations are applied
 *   - schema rows make sense (documents/chunks/embeddings counts non-negative)
 *   - vault path exists and is readable (when configured)
 *   - reports last_indexed_mtime spread (oldest / newest / count)
 */
import { existsSync, statSync } from "node:fs";
import { Storage } from "../core/storage.ts";
import { loadConfig, defaultConfigPath } from "../core/config.ts";
import { categorize, type CheckCategory } from "../core/doctor-categories.ts";
import { rankIssues, type RankedIssue } from "../core/doctor-cause-rank.ts";
import packageJson from "../../package.json" with { type: "json" };

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

/** A check as rendered: the raw check plus its category. */
interface CategorizedCheck extends Check {
  category: CheckCategory;
}

export interface DoctorOptions {
  /** Override the config path. Tests use this to point at a temp dir
   *  (Bun's `os.homedir()` caches at process start, so HOME env tricks
   *  don't work). Defaults to `~/.memex/config.json`. */
  configPath?: string;
}

export async function runDoctor(opts: DoctorOptions = {}): Promise<void> {
  const checks: Check[] = [];
  let config: ReturnType<typeof loadConfig> | null = null;

  // 1. config file
  const cfgPath = opts.configPath ?? defaultConfigPath();
  if (!existsSync(cfgPath)) {
    checks.push({
      name: "config",
      ok: false,
      detail: `missing at ${cfgPath} — run 'memex init --pglite'`,
    });
  } else {
    try {
      config = loadConfig(cfgPath);
      checks.push({ name: "config", ok: true, detail: cfgPath });
    } catch (e) {
      checks.push({
        name: "config",
        ok: false,
        detail: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // 2. PGLite + schema
  let storage: Storage | null = null;
  if (config) {
    try {
      storage = new Storage(config);
      await storage.init();
      checks.push({
        name: "pglite",
        ok: true,
        detail: config.database.path,
      });
    } catch (e) {
      checks.push({
        name: "pglite",
        ok: false,
        detail: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // 3. stats + last_indexed_mtime spread
  if (storage) {
    try {
      const stats = await storage.stats();
      checks.push({
        name: "stats",
        ok: stats.documents >= 0 && stats.chunks >= 0,
        detail: `documents=${stats.documents} chunks=${stats.chunks} embeddings=${stats.embeddings}`,
      });

      const r = await storage
        .raw()
        .query<{ oldest: number | string | null; newest: number | string | null; n: number }>(
          `SELECT MIN(last_indexed_mtime) AS oldest,
                  MAX(last_indexed_mtime) AS newest,
                  COUNT(last_indexed_mtime)::int AS n
           FROM documents`,
        );
      const row = r.rows[0];
      // BIGINT comes back as `number` from PGLite, `string` from postgres-js;
      // coerce so `new Date(...)` produces a sane value either way.
      const toNum = (v: unknown): number | null => {
        if (v === null || v === undefined) return null;
        const x = typeof v === "number" ? v : Number(v);
        return Number.isFinite(x) ? x : null;
      };
      const oldest = toNum(row?.oldest);
      const newest = toNum(row?.newest);
      const n = row?.n ?? 0;
      checks.push({
        name: "index-spread",
        ok: true,
        detail:
          n === 0
            ? "no documents indexed yet"
            : `n=${n} oldest=${
                oldest ? new Date(oldest).toISOString() : "n/a"
              } newest=${
                newest ? new Date(newest).toISOString() : "n/a"
              }`,
      });
    } catch (e) {
      checks.push({
        name: "stats",
        ok: false,
        detail: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // 4. vault path (only when configured)
  const vault =
    process.env.MEMEX_VAULT_PATH ?? config?.storage.vault ?? null;
  if (vault) {
    try {
      const st = statSync(vault);
      if (!st.isDirectory()) {
        checks.push({
          name: "vault",
          ok: false,
          detail: `${vault} exists but is not a directory`,
        });
      } else {
        checks.push({ name: "vault", ok: true, detail: vault });
      }
    } catch {
      checks.push({
        name: "vault",
        ok: false,
        detail: `${vault} not readable`,
      });
    }
  } else {
    checks.push({
      name: "vault",
      ok: true,
      detail: "not configured (recipe disabled)",
    });
  }

  if (storage) {
    await storage.close();
  }

  const pass = checks.every((c) => c.ok);

  // Categorize each check (brain / ops / meta) and roll up per-category
  // pass/fail counts so the report shows signal-to-noise on the question the
  // operator is asking, not one flat equal-weight list.
  const categorized: CategorizedCheck[] = checks.map((c) => ({
    ...c,
    category: categorize(c.name),
  }));
  const byCategory: Record<CheckCategory, { ok: number; fail: number }> = {
    brain: { ok: 0, fail: 0 },
    ops: { ok: 0, fail: 0 },
    meta: { ok: 0, fail: 0 },
  };
  for (const c of categorized) {
    byCategory[c.category][c.ok ? "ok" : "fail"]++;
  }
  // Root-cause-first ordering of the failures (ordering only — see
  // doctor-cause-rank.ts honesty contract).
  const rankedFailures: RankedIssue[] = rankIssues(checks);

  console.log(
    JSON.stringify(
      {
        ok: pass,
        version: packageJson.version,
        checks: categorized,
        summary: {
          by_category: byCategory,
          ranked_failures: rankedFailures,
        },
      },
      null,
      2,
    ),
  );
  if (!pass) process.exitCode = 1;
}
