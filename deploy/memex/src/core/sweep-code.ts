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
import { walkFiles } from "./walk.ts";
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
}

export interface SweepCodeResult {
  scanned: number;
  reindexed: number;
  skipped: number;
  parseErrors: number;
  errors: { path: string; message: string }[];
  /** Per-root file counts. Useful for the empty-root WARNING in serve.ts. */
  perRoot: { root: string; files: number; missing: boolean }[];
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

  const perFileDelayMs = Math.max(0, opts.perFileDelayMs ?? 0);
  const maxFiles = opts.maxFiles ?? Number.POSITIVE_INFINITY;

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

  return result;
}
