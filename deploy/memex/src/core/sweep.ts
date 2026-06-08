/**
 * Vault sweep — walk a directory recursively, look at every `.md` file,
 * compare on-disk mtime to documents.last_indexed_mtime, and re-index
 * the ones that are new or stale.
 *
 * The walk is intentionally synchronous (readdirSync) — vault size is
 * O(thousands), not O(millions), and async iteration just adds overhead
 * for negligible parallelism gains given the embed roundtrips dominate.
 */
import { createHash } from "node:crypto";
import type { Storage } from "./storage.ts";
import { indexFile } from "./indexer.ts";
import { walkFiles } from "./walk.ts";

export interface SweepOptions {
  /** Filesystem root of the vault. */
  vault: string;
  /** Globs to skip (literal-matched against the relative path). Defaults
   *  cover editor/tooling dotfile dirs + the memex data dir. */
  ignore?: string[];
  /** When true, re-index every file regardless of mtime. */
  force?: boolean;
  /**
   * Sleep this many ms between consecutive file indexes. Defaults to 0
   * (no delay). Useful as a safety knob on tiny instances where the
   * cumulative working set of PGLite + Bun JIT + chokidar + in-flight
   * Titan responses can OOM the host (caught on t4g.small / 2 GB). At
   * ~50 ms the sweep paces ~20 docs/sec, which is well below
   * Bedrock's regional Titan TPM/RPM ceilings.
   */
  perFileDelayMs?: number;
  /**
   * Stop after this many *re-indexes* (skipped files don't count).
   * Defaults to unlimited. Useful for smoke runs ("just chew through
   * 50 docs to test") without committing to the whole vault.
   */
  maxFiles?: number;
}

export interface SweepResult {
  scanned: number;
  reindexed: number;
  skipped: number;
  errors: { path: string; message: string }[];
}

const DEFAULT_IGNORES = [
  ".obsidian",
  ".trash",
  ".git",
  "memex",
  ".memex",
  "node_modules",
];

function shortHash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

function docId(sourcePath: string): string {
  return `doc_${shortHash(sourcePath)}`;
}

// File walking lives in core/walk.ts so the markdown sweep and the
// code sweep (sweep-code.ts) share one implementation.

/**
 * Walk the vault, compare mtime against documents.last_indexed_mtime,
 * re-index changed files. Returns a small summary suitable for logging.
 */
export async function sweepVault(
  storage: Storage,
  opts: SweepOptions,
): Promise<SweepResult> {
  const ignore = new Set([...(opts.ignore ?? []), ...DEFAULT_IGNORES]);
  const result: SweepResult = {
    scanned: 0,
    reindexed: 0,
    skipped: 0,
    errors: [],
  };

  // Pull all known last_indexed_mtime in one shot — vault is small enough
  // that this is much cheaper than per-file SELECT.
  const known = new Map<string, number | null>();
  const rows = await storage
    .raw()
    .query<{ id: string; last_indexed_mtime: number | null }>(
      "SELECT id, last_indexed_mtime FROM documents",
    );
  for (const r of rows.rows) {
    known.set(r.id, r.last_indexed_mtime);
  }

  const perFileDelayMs = Math.max(0, opts.perFileDelayMs ?? 0);
  const maxFiles = opts.maxFiles ?? Number.POSITIVE_INFINITY;

  for (const file of walkFiles(opts.vault, {
    extensions: [".md"],
    ignore,
  })) {
    result.scanned++;
    const id = docId(file.path);
    const lastIndexed = known.get(id) ?? null;
    if (
      !opts.force &&
      lastIndexed !== null &&
      lastIndexed >= file.mtimeMs
    ) {
      result.skipped++;
      continue;
    }
    if (result.reindexed >= maxFiles) {
      // Budget exhausted — stop walking. Subsequent scans will pick up where
      // we left off (since last_indexed_mtime gets written on each success).
      break;
    }
    try {
      await indexFile(storage, file.path);
      result.reindexed++;
    } catch (e) {
      result.errors.push({
        path: file.path,
        message: e instanceof Error ? e.message : String(e),
      });
    }
    if (perFileDelayMs > 0) {
      await new Promise((res) => setTimeout(res, perFileDelayMs));
    }
  }

  return result;
}
