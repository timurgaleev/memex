/**
 * Where a write's time goes. An interactive write (`page_put` and friends)
 * spends almost all of its latency in paid calls, and a timer inside the
 * indexer cannot tell a Bedrock round trip from the wait for an inflight slot
 * or from the spend-ledger queries that bracket every paid call. The layers
 * that do each of those report here instead, through AsyncLocalStorage, so the
 * split survives the await chain without threading a parameter through every
 * call signature — the same way `runWithSpendClient` scopes the spend client.
 *
 * Outside a `runWithWriteTiming` scope every report is a no-op.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export interface WriteTiming {
  /** Waiting for a write-path embed slot before a chunk's work could start. */
  slotMs: number;
  /** Waiting for an inflight slot before a paid call could start. */
  queueMs: number;
  /** Inside the paid call, queue wait included — subtract `queueMs` for Bedrock.
   *  Chunks run in parallel, so this is summed across calls and can exceed the
   *  write's wall-clock time. */
  sendMs: number;
  /** The client-cap lookup and the spend-ledger insert around each paid call. */
  ledgerMs: number;
}

const store = new AsyncLocalStorage<WriteTiming>();

export function newWriteTiming(): WriteTiming {
  return { slotMs: 0, queueMs: 0, sendMs: 0, ledgerMs: 0 };
}

/** Run `fn` with `timing` as the scope. The caller holds `timing`, so what was
 *  recorded is still readable when `fn` throws. */
export function runWithWriteTiming<T>(timing: WriteTiming, fn: () => Promise<T>): Promise<T> {
  return store.run(timing, fn);
}

export function noteWriteTiming(field: keyof WriteTiming, ms: number): void {
  const timing = store.getStore();
  if (timing) timing[field] += ms;
}
