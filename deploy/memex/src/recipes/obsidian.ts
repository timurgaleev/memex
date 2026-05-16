/**
 * Obsidian recipe — turns a vault path into a live, continually-indexed
 * brain. Two phases:
 *
 *   1. Initial sweep on startup. Walks the whole tree, re-indexes anything
 *      whose mtime is newer than its last_indexed_mtime row.
 *   2. Watcher (chokidar). For every .md add/change, debounce ~1s and
 *      re-index. The 1s debounce coalesces editor save bursts.
 *
 * Lifecycle is owned by `serve` — recipe.start() runs the sweep async and
 * returns a stop() that closes the watcher cleanly on SIGINT/SIGTERM.
 */
import chokidar, { type FSWatcher } from "chokidar";
import { readFileSync, statSync } from "node:fs";
import type { Storage } from "../core/storage.ts";
import { indexFile } from "../core/indexer.ts";
import { sweepVault, type SweepResult } from "../core/sweep.ts";
import {
  registerSource,
  backfillDocumentSources,
  type SourceKind,
  type SyncPolicy,
} from "../core/sources.ts";

export interface ObsidianRecipeOptions {
  vault: string;
  /** Drop debounce window in ms. Default 1000. */
  debounceMs?: number;
  /** Same ignore globs the sweep uses. */
  ignore?: string[];
  /** Sleep this many ms between files in the initial sweep — see
   *  SweepOptions.perFileDelayMs. Default 0. */
  sweepPerFileDelayMs?: number;
  /** Cap how many files the initial sweep re-indexes — see
   *  SweepOptions.maxFiles. Default unlimited. */
  sweepMaxFiles?: number;
  /** Source identity for the registered source row. Default
   *  derives from the path: /vault → vault, /memory → memory, else other. */
  sourceId?: string;
  sourceKind?: SourceKind;
  syncPolicy?: SyncPolicy;
}

function defaultSourceFor(vault: string): {
  id: string;
  kind: SourceKind;
  syncPolicy: SyncPolicy;
} {
  if (vault === "/vault" || vault.endsWith("/vault")) {
    return { id: "obsidian-vault", kind: "vault", syncPolicy: "synced" };
  }
  if (vault === "/memory" || vault.endsWith("/memory")) {
    return { id: "openclaw-memory", kind: "memory", syncPolicy: "local-only" };
  }
  return {
    id: `path:${vault}`,
    kind: "other",
    syncPolicy: "local-only",
  };
}

export interface ObsidianRecipeHandle {
  /** Resolves once the initial sweep completes. */
  initialSweep: Promise<SweepResult>;
  /** Stops the watcher and waits for in-flight indexes to settle. */
  stop: () => Promise<void>;
}

const DEFAULT_DEBOUNCE = 1000;
const DEFAULT_IGNORE_GLOBS = [
  /(^|[\\\/])\..+/, // dotfiles + .obsidian, .git, .trash
  /(^|[\\\/])(memex|node_modules)([\\\/]|$)/,
];

export function startObsidianRecipe(
  storage: Storage,
  opts: ObsidianRecipeOptions,
): ObsidianRecipeHandle {
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE;

  // register this vault as a source. Idempotent ON CONFLICT.
  // Run async without awaiting — sweep + watcher don't depend on it,
  // and a transient DB error here shouldn't kill recipe startup.
  const defaults = defaultSourceFor(opts.vault);
  registerSource(storage.engine(), {
    id: opts.sourceId ?? defaults.id,
    kind: opts.sourceKind ?? defaults.kind,
    pathPrefix: opts.vault,
    syncPolicy: opts.syncPolicy ?? defaults.syncPolicy,
  })
    .then(() => backfillDocumentSources(storage.engine()))
    .then((b) => {
      if (b.updated > 0) {
        console.log(
          `[obsidian] source registered for ${opts.vault}; backfilled ${b.updated} doc(s) (unmatched=${b.unmatched})`,
        );
      }
    })
    .catch((e) =>
      console.warn(
        `[obsidian] source registration for ${opts.vault} failed:`,
        e instanceof Error ? e.message : e,
      ),
    );

  // Run the initial sweep async so the HTTP server doesn't block on it.
  const initialSweep = sweepVault(storage, {
    vault: opts.vault,
    ignore: opts.ignore,
    perFileDelayMs: opts.sweepPerFileDelayMs,
    maxFiles: opts.sweepMaxFiles,
  })
    .then((r) => {
      console.log(
        `[obsidian] initial sweep: scanned=${r.scanned} reindexed=${r.reindexed} skipped=${r.skipped} errors=${r.errors.length}`,
      );
      for (const e of r.errors.slice(0, 5)) {
        console.warn(`[obsidian] sweep error ${e.path}: ${e.message}`);
      }
      return r;
    })
    .catch((e) => {
      console.error(`[obsidian] initial sweep failed:`, e);
      throw e;
    });

  const watcher: FSWatcher = chokidar.watch(opts.vault, {
    ignored: DEFAULT_IGNORE_GLOBS,
    ignoreInitial: true, // initial sweep handles existing files
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    persistent: true,
    // chokidar's default fs.watch is the lightest option on linux;
    // if EFS inotify proves flaky we can flip to usePolling: true here.
  });

  const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const inFlight = new Set<Promise<unknown>>();
  // Backpressure caps — a `git checkout` on a 10k-file branch fires
  // chokidar events at line-rate; without limits we'd allocate a
  // timer + Promise for every event and exhaust the single PGLite
  // connection in transaction. Caps below are deliberately generous
  // for normal interactive editing but reject the pathological burst.
  const MAX_PENDING_TIMERS = 1000;
  const MAX_IN_FLIGHT = 4;
  let dropped = 0;
  let lastDropLog = 0;

  const logDropMaybe = (): void => {
    const now = Date.now();
    if (now - lastDropLog > 30_000) {
      console.warn(
        `[obsidian] backpressure: ${dropped} event(s) dropped since startup`,
      );
      lastDropLog = now;
    }
  };

  const onChange = (filePath: string): void => {
    if (!filePath.endsWith(".md")) return;
    // Coalesce rapid same-file events.
    const existing = pendingTimers.get(filePath);
    if (existing) clearTimeout(existing);
    else if (pendingTimers.size >= MAX_PENDING_TIMERS) {
      // Drop this new event entirely rather than unbound the queue.
      // The boot sweep + dream cycle eventually pick the file up.
      dropped++;
      logDropMaybe();
      return;
    }
    const t = setTimeout(() => {
      pendingTimers.delete(filePath);
      // Backpressure on indexFile fan-out: wait for an in-flight slot
      // before kicking off a new reindex.
      const start = async (): Promise<void> => {
        while (inFlight.size >= MAX_IN_FLIGHT) {
          await new Promise((r) => setTimeout(r, 50));
        }
        // Skip files that were deleted between the event and the timer.
        try {
          statSync(filePath);
        } catch {
          return;
        }
        const p = indexFile(storage, filePath)
          .then((r) => {
            console.log(
              `[obsidian] reindexed ${filePath} chunks=${r.chunks} entities=${r.entities}`,
            );
          })
          .catch((e) => {
            console.warn(
              `[obsidian] reindex ${filePath} failed:`,
              e instanceof Error ? e.message : e,
            );
          })
          .finally(() => {
            inFlight.delete(p);
          });
        inFlight.add(p);
      };
      void start();
    }, debounceMs);
    pendingTimers.set(filePath, t);
  };

  watcher.on("add", onChange);
  watcher.on("change", onChange);
  // ignores deletes — to be wired up alongside the integrity
  // checker (vault-vs-index drift detection) when that ships.

  return {
    initialSweep,
    stop: async () => {
      for (const t of pendingTimers.values()) clearTimeout(t);
      pendingTimers.clear();
      await watcher.close();
      // Wait for any in-flight indexes started just before stop().
      await Promise.allSettled(inFlight);
    },
  };
}

/**
 * Read frontmatter to detect a noteable's archived state — useful but
 * orthogonal; exported so the future integrity checker can re-use it.
 */
export function readFrontmatterField(
  filePath: string,
  field: string,
): string | null {
  try {
    const md = readFileSync(filePath, "utf8");
    if (!md.startsWith("---")) return null;
    const end = md.indexOf("\n---", 4);
    if (end < 0) return null;
    const fm = md.slice(0, end);
    const re = new RegExp(`^${field}:\\s*(.+)$`, "m");
    const m = fm.match(re);
    return m ? (m[1] ?? "").trim() : null;
  } catch {
    return null;
  }
}
