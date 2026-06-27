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
import { brainHealthMetrics } from "../core/source-health.ts";
import { countStalePagesForExtraction, LINK_EXTRACTOR_VERSION_TS } from "../core/links.ts";
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

    // 3b. brain health metrics (embed coverage / lag / queue / failed jobs).
    // Informational by design: a failed job in the last 24h is the only
    // unambiguous "broken" signal, so that alone gates ok. Coverage / lag /
    // queue are surfaced in the detail for the operator to judge — a brain can
    // legitimately run with partial embedding coverage (graph-only sources, a
    // pending backfill), so the doctor reports it rather than declaring it bad.
    try {
      const h = await brainHealthMetrics(storage.raw());
      checks.push({
        name: "source-health",
        ok: h.failed_jobs_24h === 0,
        detail:
          `embed_coverage=${(h.embed_coverage_pct * 100).toFixed(1)}% ` +
          `(${h.embedded_chunks}/${h.embeddable_chunks} embeddable` +
          `${h.code_chunks > 0 ? `, ${h.code_chunks} code graph-only` : ""}) ` +
          `lag=${h.lag_seconds === null ? "n/a" : `${h.lag_seconds}s`} ` +
          `queue=${h.queue_depth} failed_24h=${h.failed_jobs_24h}`,
      });
    } catch (e) {
      checks.push({
        name: "source-health",
        ok: false,
        detail: e instanceof Error ? e.message : String(e),
      });
    }

    // Link-extraction lag (migration 051). Informational by design (ok:true):
    // a backlog of un-extracted pages degrades graph coverage but a brain can
    // legitimately run with it (autopilot off, a fresh import). Surfaced so the
    // operator can re-put / sweep. After mig 051 every pre-existing page reads
    // stale (NULL watermark) until it is next written — that backlog is the
    // point of the check.
    try {
      const e = storage.raw();
      const totalR = await e.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM pages WHERE deleted_at IS NULL",
      );
      const total = totalR.rows[0]?.n ?? 0;
      const stale = total > 0 ? await countStalePagesForExtraction(e, { versionTs: LINK_EXTRACTOR_VERSION_TS }) : 0;
      const pct = total > 0 ? ((stale / total) * 100).toFixed(1) : "0.0";
      checks.push({
        name: "links-extraction-lag",
        ok: true,
        detail: `${stale}/${total} page(s) stale for link extraction (${pct}%)`,
      });
    } catch (e) {
      checks.push({
        name: "links-extraction-lag",
        ok: true,
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
