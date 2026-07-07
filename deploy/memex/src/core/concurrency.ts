/**
 * Small FIFO semaphore for bounding the number of concurrent async
 * calls (e.g. indexFile() during a sweep, or a batched embed pass).
 * A polling loop (`while (inFlight.size >= N) await sleep(50)`) gives
 * non-deterministic ordering and busy-waits; this gives FIFO + zero
 * latency floor.
 *
 * Currently unwired — the per-process inflight cap in the LLM gateway
 * covers today's concurrency ceiling; kept as a generic primitive for
 * embed-batch gating when a bounded local fan-out is next needed.
 *
 * Single-threaded JS so no locking is needed — acquire() returns a
 * Promise that resolves when a slot opens; release() drains the next
 * waiter in arrival order. Hand the returned `release` to caller
 * code via `.finally()` so a thrown reindex doesn't leak a slot.
 */
export class Semaphore {
  private permits: number;
  private waiters: Array<() => void> = [];

  constructor(max: number) {
    if (max < 1) throw new Error(`Semaphore: max must be >= 1, got ${max}`);
    this.permits = max;
  }

  /**
   * Acquire one permit. Returns a `release` function the caller MUST
   * invoke (typically via `.finally`) when the work completes.
   */
  async acquire(): Promise<() => void> {
    if (this.permits > 0) {
      this.permits--;
      return () => this.release();
    }
    return new Promise<() => void>((resolve) => {
      this.waiters.push(() => {
        this.permits--; // claim the permit before yielding control
        resolve(() => this.release());
      });
    });
  }

  private release(): void {
    this.permits++;
    const next = this.waiters.shift();
    if (next) next();
  }

  /** Diagnostics: how many in-flight permits + how many queued waiters. */
  inFlight(): number {
    // We can derive this as (max - permits) if we tracked max; the
    // existing call sites don't need it, so keep the API minimal.
    return -this.permits; // a hint, negative = waiters waiting
  }
  pending(): number {
    return this.waiters.length;
  }
}
