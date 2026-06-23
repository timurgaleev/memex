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
 * Concurrency: there is no mutual exclusion with the periodic cycle loop -- the
 * phases are idempotent and use atomic per-row writes, so overlap can't corrupt
 * state, but running this WHILE the daemon is mid-tick can double Bedrock spend.
 * Prefer running it when the loop is idle (its first tick is one interval after
 * boot); it is the operator's responsibility for a deliberate one-shot.
 */
import { Storage } from "../core/storage.ts";
import { loadConfig } from "../core/config.ts";
import {
  ALL_PHASES,
  SYNTHESIS_PHASES,
  runCycleOnce,
  type CycleOptions,
  type PhaseName,
} from "../core/cycle/index.ts";

export interface CycleCmdOptions {
  /** Limit to these phases (default: all). */
  phases?: PhaseName[];
  /** Forwarded to embed-stale. */
  staleDays?: number;
}

// Accept the default phases PLUS the opt-in synthesis phases (which are not in
// ALL_PHASES by design, but are valid to request explicitly).
const VALID_PHASES: readonly PhaseName[] = [...ALL_PHASES, ...SYNTHESIS_PHASES];
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
  const config = loadConfig();
  const storage = new Storage(config);
  await storage.init();
  try {
    const cycleOpts: CycleOptions = { storage };
    if (opts.phases !== undefined) cycleOpts.phases = opts.phases;
    if (opts.staleDays !== undefined) cycleOpts.staleDays = opts.staleDays;
    const r = await runCycleOnce(storage.engine(), cycleOpts);
    console.log(JSON.stringify(r, null, 2));
  } finally {
    await storage.close();
  }
}
