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
import { Semaphore } from "../core/concurrency.ts";
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
    // Opaque historical source-id, retained verbatim because it is a
    // LIVE database key: every row in `sources` / `documents` references
    // this exact string via a foreign key. Renaming it is a data
    // migration on the running DB, not a code edit — deferred to the
    // memory-store migration. Treat it as data, not a name.
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

  // ---------------------------------------------------------------------
  // Backpressure design (HIGH defects in the prior version):
  //   - A `git checkout` on a 10k-file branch fires chokidar events at
  //     line-rate; without caps we'd allocate a timer + Promise for
  //     every event and starve PGLite's single connection.
  //   - The previous fix had a stale-timer race: the timer callback
  //     deleted the pendingTimers entry IMMEDIATELY then awaited the
  //     in-flight gate. A new event arriving during the wait saw no
  //     existing timer and queued a second one, leading to duplicate
  //     concurrent indexFile() for the same path.
  //   - Polling `while (inFlight.size >= N) await sleep(50)` was a
  //     busy-wait with non-deterministic ordering. Replaced with a
  //     proper FIFO semaphore.
  //   - stop() used to `pendingTimers.clear()` which dropped every
  //     in-flight debounce. Now flushes pending edits before closing.
  // MAX_IN_FLIGHT = 4 cap: PGLite is single-connection so true DB
  // parallelism is 1, but the embed roundtrip + tree-sitter parse +
  // entity extract can overlap CPU/network with the DB write. 4
  // empirically saturates the t4g.medium without thrashing.
  // ---------------------------------------------------------------------
  const MAX_PENDING_TIMERS = 1000;
  const MAX_IN_FLIGHT = 4;

  // pendingTimers: filePath → { timer, inProgress }. When the timer
  // fires we mark the entry inProgress=true and DO NOT delete it until
  // the indexFile() finally settles. A new event for the same path
  // during that window clears the timer (no-op if already fired) and
  // resets inProgress=false + schedules a fresh debounce. This kills
  // the stale-timer race.
  interface PendingEntry {
    timer: ReturnType<typeof setTimeout> | null;
    inProgress: boolean;
  }
  const pending = new Map<string, PendingEntry>();
  const semaphore = new Semaphore(MAX_IN_FLIGHT);
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

  const doReindex = async (filePath: string): Promise<void> => {
    const release = await semaphore.acquire();
    try {
      // Skip files that were deleted between event and acquisition.
      try {
        statSync(filePath);
      } catch {
        return;
      }
      try {
        const r = await indexFile(storage, filePath);
        console.log(
          `[obsidian] reindexed ${filePath} chunks=${r.chunks} entities=${r.entities}`,
        );
      } catch (e) {
        console.warn(
          `[obsidian] reindex ${filePath} failed:`,
          e instanceof Error ? e.message : e,
        );
      }
    } finally {
      release();
      // Only NOW retire the pending entry. If a new event arrived
      // during this work it will have flipped inProgress=false +
      // queued a fresh timer; that becomes its own pending entry,
      // which we mustn't clobber.
      const cur = pending.get(filePath);
      if (cur && cur.inProgress) pending.delete(filePath);
    }
  };

  const onChange = (filePath: string): void => {
    if (!filePath.endsWith(".md")) return;
    const existing = pending.get(filePath);
    if (existing && existing.timer) {
      clearTimeout(existing.timer);
    } else if (!existing && pending.size >= MAX_PENDING_TIMERS) {
      dropped++;
      logDropMaybe();
      return;
    }
    const entry: PendingEntry = existing ?? { timer: null, inProgress: false };
    // If existing.inProgress is true we still queue a fresh debounce —
    // the next reindex will run after the current one releases.
    entry.timer = setTimeout(() => {
      entry.timer = null;
      entry.inProgress = true;
      void doReindex(filePath);
    }, debounceMs);
    pending.set(filePath, entry);
  };

  watcher.on("add", onChange);
  watcher.on("change", onChange);
  // ignores deletes — to be wired up alongside the integrity
  // checker (vault-vs-index drift detection) when that ships.

  return {
    initialSweep,
    stop: async () => {
      // On SIGTERM during an editor save burst we used to drop every
      // pending debounce on the floor. Now: cancel each timer, then
      // synchronously fire its reindex so the work isn't lost. The
      // semaphore still bounds parallelism so we can't blow the DB.
      const tail: Promise<void>[] = [];
      for (const [filePath, entry] of pending.entries()) {
        if (entry.timer) {
          clearTimeout(entry.timer);
          entry.timer = null;
          entry.inProgress = true;
          tail.push(doReindex(filePath));
        }
      }
      await watcher.close();
      // Drain the tail + anything already in-flight on the semaphore.
      await Promise.allSettled(tail);
      // Spin until the semaphore reports no waiters AND no in-flight.
      while (semaphore.pending() > 0 || semaphore.inFlight() > 0) {
        await new Promise((r) => setTimeout(r, 25));
      }
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
