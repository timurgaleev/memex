/**
 * The running phase's stop signal and lock fence, carried through async
 * context so a phase's own loops can stop without every phase signature taking
 * them.
 *
 * runPhase gives each phase its own signal, aborted when the run is aborted and
 * when the phase blows its deadline. JS cannot cancel the phase's promise, so
 * an orphaned phase keeps going until it looks: `phaseCheckpoint()` at the top
 * of each loop iteration is where it looks, and `phaseFenceCheck()` before a
 * write to shared state also confirms the cycle lock is still ours, so a phase
 * whose lock was taken stops before its next write instead of overlapping the
 * new holder's run.
 *
 * Outside a phase (a direct call from a command or a test) both are no-ops.
 * Both throw PhaseStoppedError; a loop that catches per-item errors must call
 * them OUTSIDE its try block, or the stop is recorded as an item error and the
 * loop carries on.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export interface PhaseContext {
  signal: AbortSignal;
  /** Resolves false once the cycle lock is no longer ours. */
  fence?: () => Promise<boolean>;
}

const _phase = new AsyncLocalStorage<PhaseContext>();

export class PhaseStoppedError extends Error {
  constructor(readonly reason: string) {
    super(`phase stopped: ${reason}`);
  }
}

export function runInPhaseContext<T>(ctx: PhaseContext, fn: () => Promise<T>): Promise<T> {
  return _phase.run(ctx, fn);
}

/** The running phase's signal, for code that passes it on to its own calls. */
export function currentPhaseSignal(): AbortSignal | undefined {
  return _phase.getStore()?.signal;
}

function reasonOf(signal: AbortSignal): string {
  const r: unknown = signal.reason;
  return typeof r === "string" ? r : "aborted";
}

/** Throws once the running phase has been told to stop. */
export function phaseCheckpoint(): void {
  const ctx = _phase.getStore();
  if (ctx?.signal.aborted) throw new PhaseStoppedError(reasonOf(ctx.signal));
}

/**
 * phaseCheckpoint, then a check that the cycle lock still carries the tenure
 * this run acquired. Call it before each write to shared state. A lost lock
 * throws `lock_stolen`; the fence itself stops the rest of the run.
 */
export async function phaseFenceCheck(): Promise<void> {
  phaseCheckpoint();
  const ctx = _phase.getStore();
  if (!ctx?.fence) return;
  if (!(await ctx.fence())) throw new PhaseStoppedError("lock_stolen");
  phaseCheckpoint();
}
