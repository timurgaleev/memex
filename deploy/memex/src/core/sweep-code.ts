/**
 * Code sweep — walks one or more registered code-source roots, mtime-skips
 * unchanged files, calls indexCodeFile() for the rest. Mirrors the shape
 * of `core/sweep.ts sweepVault` so operators reason about both flows the
 * same way.
 *
 * Supported extensions come from `chunkers/parsers.SUPPORTED_EXTENSIONS`
 * — adding a new language flips this set automatically.
 *
 * Failure semantics:
 *   - Parse errors in one file → log to result.errors, continue with the next.
 *   - Missing/unreadable file → silently skipped by the walker.
 *   - WASM load failure → propagates up (hard fail, fixed at boot).
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import type { Storage } from "./storage.ts";
import { indexCodeFile } from "./indexer-code.ts";
import { normalizeSourcePath } from "./indexer.ts";
import { walkFiles } from "./walk.ts";
import { listStaleChunkerDocIds } from "./chunker-version.ts";
import { SUPPORTED_EXTENSIONS } from "./chunkers/parsers.ts";

export interface SweepCodeOptions {
  /** Filesystem roots to sweep (each becomes its own source). */
  paths: readonly string[];
  /** Directory basenames to skip. Defaults cover common build artifacts. */
  ignore?: readonly string[];
  /** When true, re-index every file regardless of mtime. */
  force?: boolean;
  /** Sleep this many ms between consecutive file indexes. */
  perFileDelayMs?: number;
  /** Stop after this many *re-indexes* (skipped files don't count). */
  maxFiles?: number;
  /**
   * Force-reindex documents whose stamped `chunker_version` is below
   * CODE_CHUNKER_VERSION (migration 052), even when mtime is unchanged — the
   * code half of `reindex --rechunk-stale`, same shape as `sweepVault`.
   *
   * Without it a CODE_CHUNKER_VERSION bump drains only via `--all`, because an
   * unchanged file mtime-skips no matter how old its chunks are. Targeted, not
   * free: on a bump EVERY code doc is stale, so the first run re-parses the
   * whole corpus; what it buys over `--all` is that already-current files are
   * skipped, so the run is resumable and the second run costs nothing.
   */
  forceStaleChunker?: boolean;
}

export interface SweepCodeResult {
  scanned: number;
  reindexed: number;
  skipped: number;
  parseErrors: number;
  errors: { path: string; message: string }[];
  /** Per-root file counts. Useful for the empty-root WARNING in serve.ts. */
  perRoot: { root: string; files: number; missing: boolean }[];
  /**
   * `forceStaleChunker` only: ids of chunker-stale code documents the walk never
   * reached (file deleted/moved, under an ignored dir, or indexed from a path
   * outside the configured roots). They stay stale until their file reappears or
   * they are purged — surfaced so the run signals the gap instead of reporting
   * a clean drain. Same contract as `SweepResult.staleChunkerUnreached`.
   */
  staleChunkerUnreached?: string[];
}

// Default ignore set for the CODE sweep. Intentionally narrower than
// `sweep.ts`'s markdown ignores: a code repo can legitimately contain
// a directory literally named `memex` (e.g. this repo's
// `deploy/memex/`). Including `memex` here would basename-match
// it and silently skip the entire source tree we wanted to index.
// The local PGLite data dir is `.memex` (dotted) — that variant is
// safe to keep because it never appears as a real source directory.
const DEFAULT_IGNORES: readonly string[] = [
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".cache",
  ".turbo",
  ".memex",
  "wasm",
  "vendor",
  "__pycache__",
  ".venv",
  "venv",
  ".pytest_cache",
];

function shortHash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

function docId(sourcePath: string): string {
  return `doc_${shortHash(sourcePath)}`;
}

/**
 * Walk every code path, mtime-skip, reindex stale.
 */
export async function sweepCodeRoots(
  storage: Storage,
  opts: SweepCodeOptions,
): Promise<SweepCodeResult> {
  const ignore = new Set([...(opts.ignore ?? []), ...DEFAULT_IGNORES]);
  const result: SweepCodeResult = {
    scanned: 0,
    reindexed: 0,
    skipped: 0,
    parseErrors: 0,
    errors: [],
    perRoot: [],
  };

  // Pull all known last_indexed_mtime in one shot — cheaper than per-file SELECT.
  const known = new Map<string, number | null>();
  const rows = await storage
    .raw()
    .query<{ id: string; last_indexed_mtime: number | null }>(
      "SELECT id, last_indexed_mtime FROM documents",
    );
  for (const r of rows.rows) {
    known.set(r.id, r.last_indexed_mtime);
  }

  // Targeted re-chunk: the code-doc ids whose chunks predate the current code
  // chunker version. A walked file in this set is re-indexed regardless of
  // mtime. Kind-narrowed — this walk never sees a markdown file.
  const staleChunkerIds = opts.forceStaleChunker
    ? await listStaleChunkerDocIds(storage.raw(), "code")
    : null;
  const seenStaleIds = staleChunkerIds ? new Set<string>() : null;

  const perFileDelayMs = Math.max(0, opts.perFileDelayMs ?? 0);
  const maxFiles = opts.maxFiles ?? Number.POSITIVE_INFINITY;
  let budgetBroke = false;

  for (const root of opts.paths) {
    const perRoot = { root, files: 0, missing: !existsSync(root) };
    if (perRoot.missing) {
      result.perRoot.push(perRoot);
      continue;
    }
    for (const file of walkFiles(root, {
      extensions: SUPPORTED_EXTENSIONS,
      ignore,
    })) {
      perRoot.files++;
      result.scanned++;
      // Same reason as the vault sweep: indexCodeFile stores the CANONICAL
      // path, so hashing the walked shape instead makes every mtime skip miss
      // whenever a code root is relative — the whole tree re-indexes on every
      // tick and the skip quietly stops being a skip.
      const id = docId(normalizeSourcePath(file.path));
      const lastIndexed = known.get(id) ?? null;
      const forcedByChunker = staleChunkerIds?.has(id) ?? false;
      if (forcedByChunker) seenStaleIds!.add(id);
      if (
        !opts.force &&
        !forcedByChunker &&
        lastIndexed !== null &&
        lastIndexed >= file.mtimeMs
      ) {
        result.skipped++;
        continue;
      }
      if (result.reindexed >= maxFiles) {
        budgetBroke = true;
        break;
      }
      try {
        const out = await indexCodeFile(storage, file.path);
        result.reindexed++;
        if (out.hasParseError) result.parseErrors++;
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
    result.perRoot.push(perRoot);
  }

  // Only meaningful on a COMPLETE walk: a maxFiles break leaves later stale
  // files unwalked-but-not-orphaned (they resume next run), so don't flag them.
  if (staleChunkerIds && seenStaleIds && !budgetBroke) {
    const unreached = [...staleChunkerIds].filter((id) => !seenStaleIds.has(id));
    if (unreached.length > 0) result.staleChunkerUnreached = unreached;
  }

  return result;
}
