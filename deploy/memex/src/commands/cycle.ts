/**
 * `memex cycle [--phases a,b,c] [--stale-days N]` -- run ONE maintenance cycle
 * on demand, then exit. The same `runCycleOnce` the periodic loop runs, but
 * one-shot: useful right after a deploy/import to realize the cycle-driven
 * backfills (page salience, fact embeddings, link reconcile, ...) immediately
 * instead of waiting for the next scheduled tick, and to verify a phase on the
 * live dataset.
 *
 * `--phases` limits the run to a comma-separated subset (default: all phases).
 * Prints the per-phase result envelope as JSON. Read/compute-heavy phases
 * (embed-stale, embed-facts) call Bedrock, so scope with `--phases` to control
 * cost when you only need one backfill.
 *
 * Concurrency: this shares the daemon's `memex-cycle` DB lock, so a one-shot
 * run and a periodic tick can't overlap and double Bedrock spend. If the daemon
 * is mid-tick when this runs, the one-shot skips with a message and exits 0
 * (the phases are idempotent; the daemon's tick already covers the work).
 */
import { Storage } from "../core/storage.ts";
import { loadConfig } from "../core/config.ts";
import {
  ALL_PHASES,
  SYNTHESIS_PHASES,
  FACTS_MAINT_PHASES,
  runCycleOnce,
  type CycleOptions,
  type PhaseName,
} from "../core/cycle/index.ts";
import {
  CYCLE_LOCK_ID,
  tryAcquireDbLock,
  reapDeadHolderLocks,
} from "../core/db-lock.ts";

// Same TTL the daemon loop uses (recipes/cycle.ts) so the two contend on
// identical terms — a crashed holder's row TTL-expires within this window.
const LOCK_TTL_MINUTES = 5;

export interface CycleCmdOptions {
  /** Limit to these phases (default: all). */
  phases?: PhaseName[];
  /** Forwarded to embed-stale. */
  staleDays?: number;
  /**
   * @internal Injected Storage for hermetic tests. When set, the caller owns
   * its lifecycle (runCycle does NOT close it). Production leaves this unset and
   * runCycle builds + closes its own from loadConfig().
   */
  storage?: Storage;
}

// Accept the default phases PLUS the opt-in synthesis + facts-maintenance
// phases (not in ALL_PHASES by design, but valid to request explicitly).
const VALID_PHASES: readonly PhaseName[] = [
  ...ALL_PHASES,
  ...SYNTHESIS_PHASES,
  ...FACTS_MAINT_PHASES,
];
const PHASE_SET: ReadonlySet<string> = new Set(VALID_PHASES);

/** Parse + validate a `--phases` CSV against the known phase names. Throws on
 *  an empty result (so `--phases ""` / `--phases ,` fails LOUD instead of
 *  silently falling back to ALL phases and a full Bedrock-cost run) and on any
 *  unknown name; de-dupes so a repeated phase runs once. */
export function parsePhasesArg(raw: string): PhaseName[] {
  const names = Array.from(
    new Set(
      raw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    ),
  );
  if (names.length === 0) {
    throw new Error(
      `memex cycle: --phases is empty -- give a comma-separated subset of: ${VALID_PHASES.join(", ")}`,
    );
  }
  const bad = names.filter((n) => !PHASE_SET.has(n));
  if (bad.length > 0) {
    throw new Error(
      `memex cycle: unknown phase(s) ${bad.join(", ")} -- valid: ${VALID_PHASES.join(", ")}`,
    );
  }
  return names as PhaseName[];
}

export async function runCycle(opts: CycleCmdOptions = {}): Promise<void> {
  const injected = opts.storage;
  const storage = injected ?? new Storage(loadConfig());
  if (!injected) await storage.init();
  try {
    // Reclaim a lock stranded by a crashed holder, then contend for it. A null
    // handle means a LIVE holder (the daemon mid-tick) owns it — skip rather
    // than run a second overlapping cycle that would double Bedrock spend.
    try {
      await reapDeadHolderLocks(storage.engine());
    } catch {
      /* best-effort sweep */
    }
    const lock = await tryAcquireDbLock(
      storage.engine(),
      CYCLE_LOCK_ID,
      LOCK_TTL_MINUTES,
    );
    if (!lock) {
      console.log(
        `[cycle] skipped: another holder owns ${CYCLE_LOCK_ID} (daemon mid-tick) — nothing to do`,
      );
      return;
    }
    // Heartbeat so a long one-shot (a heavy embed-stale pass) can't outlive the
    // short TTL and let the daemon acquire concurrently. unref so it never pins
    // the event loop past the run.
    const refresher = setInterval(() => {
      void lock.refresh().catch(() => {});
    }, 30 * 1000);
    (refresher as unknown as { unref?: () => void }).unref?.();
    try {
      const cycleOpts: CycleOptions = { storage };
      if (opts.phases !== undefined) cycleOpts.phases = opts.phases;
      if (opts.staleDays !== undefined) cycleOpts.staleDays = opts.staleDays;
      const r = await runCycleOnce(storage.engine(), cycleOpts);
      console.log(JSON.stringify(r, null, 2));
    } finally {
      clearInterval(refresher);
      await lock.release();
    }
  } finally {
    if (!injected) await storage.close();
  }
}
