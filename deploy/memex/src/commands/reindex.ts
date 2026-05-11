/**
 * `memex reindex [--source vault|code|all] [--all] [--vault PATH] [--paths CSV]`
 *
 * Manual sweep trigger.
 *
 * Use cases:
 *   - first-time bootstrap on a new EC2 if the watcher didn't see the
 *     existing tree (it should, but `--all` exists as a safety net)
 *   - after schema changes that invalidate stored chunks
 *   - debugging
 *   - re-indexing the code corpus after `git pull` on the openclaw
 *     repo bind-mount (`--source code [--all]`)
 *
 * Without `--all`, behaves like the recipe's startup sweep: only
 * re-index files newer than their last_indexed_mtime.
 *
 * `--source` defaults to `vault` for backward compatibility. `--paths`
 * (CSV) overrides `MEMEX_CODE_PATHS` for the code sweep.
 */
import { Storage } from "../core/storage.ts";
import { sweepVault, type SweepResult } from "../core/sweep.ts";
import { sweepCodeRoots, type SweepCodeResult } from "../core/sweep-code.ts";
import { loadConfig } from "../core/config.ts";

export interface ReindexCommandOptions {
  all?: boolean;
  vault?: string;
  source?: "vault" | "code" | "all";
  /** CSV of code roots; overrides MEMEX_CODE_PATHS env var. */
  codePaths?: string;
}

interface VaultReindexResult {
  kind: "vault";
  vault: string;
  result: SweepResult;
}

interface CodeReindexResult {
  kind: "code";
  paths: string[];
  result: SweepCodeResult;
}

function parseCodePaths(opts: ReindexCommandOptions): string[] {
  const explicit = opts.codePaths ?? process.env.MEMEX_CODE_PATHS;
  if (!explicit || explicit.length === 0) return [];
  return explicit
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function resolveVaultPath(
  config: ReturnType<typeof loadConfig>,
  override: string | undefined,
): string | null {
  return (
    override ??
    process.env.MEMEX_VAULT_PATH ??
    config.storage.vault ??
    null
  );
}

export async function runReindex(
  opts: ReindexCommandOptions,
): Promise<void> {
  const config = loadConfig();
  const source = opts.source ?? "vault";
  const storage = new Storage(config);
  await storage.init();

  try {
    const out: (VaultReindexResult | CodeReindexResult)[] = [];

    if (source === "vault" || source === "all") {
      const vault = resolveVaultPath(config, opts.vault);
      if (!vault && source === "vault") {
        throw new Error(
          "memex reindex: vault path is required (--vault PATH, $MEMEX_VAULT_PATH, or storage.vault in config.json)",
        );
      }
      if (vault) {
        const result = await sweepVault(storage, {
          vault,
          force: opts.all ?? false,
        });
        out.push({ kind: "vault", vault, result });
      }
    }

    if (source === "code" || source === "all") {
      const paths = parseCodePaths(opts);
      if (paths.length === 0) {
        if (source === "code") {
          throw new Error(
            "memex reindex --source code: no paths configured (set --paths CSV or MEMEX_CODE_PATHS)",
          );
        }
      } else {
        const result = await sweepCodeRoots(storage, {
          paths,
          force: opts.all ?? false,
        });
        out.push({ kind: "code", paths, result });
      }
    }

    console.log(JSON.stringify({ ok: true, runs: out }, null, 2));
  } finally {
    await storage.close();
  }
}
