/**
 * Small FIFO semaphore for bounding the number of concurrent async
 * calls (e.g. indexFile() during a sweep, or a batched embed pass).
 * A polling loop (`while (inFlight.size >= N) await sleep(50)`) gives
 * non-deterministic ordering and busy-waits; this gives FIFO + zero
 * latency floor.
 *
 * Wired as the write-path embed ceiling below.
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

const DEFAULT_WRITE_EMBED_WIDTH = 4;

/**
 * How many chunks the write path situates and embeds at once, across every
 * concurrent write in the process (`MEMEX_EMBED_MAX_INFLIGHT`, default 4).
 * Deliberately NOT `MEMEX_EMBED_CONCURRENCY`, which is the backfill's own pool
 * width, and deliberately not taken inside `embedText`: the search path races a
 * query embed against a wall clock that starts before any wait, so sharing this
 * ceiling with it would turn a busy write into keyword-only search.
 */
export function writeEmbedWidth(): number {
  const n = Number.parseInt(process.env.MEMEX_EMBED_MAX_INFLIGHT ?? "", 10);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_WRITE_EMBED_WIDTH;
}

let writeSlots: { width: number; sem: Semaphore } | null = null;

/**
 * Take one write-path embed slot; call the returned function to give it back.
 * The semaphore is rebuilt when the configured width changes. A rebuild while
 * slots are held briefly admits up to the old width on top of the new one —
 * acceptable for a knob that changes at deploy time, not mid-write.
 */
export function acquireWriteEmbedSlot(): Promise<() => void> {
  const width = writeEmbedWidth();
  if (!writeSlots || writeSlots.width !== width) {
    writeSlots = { width, sem: new Semaphore(width) };
  }
  return writeSlots.sem.acquire();
}

/** Test seam: forget the shared semaphore so a test starts from a clean width. */
export function _resetWriteEmbedSlotsForTests(): void {
  writeSlots = null;
}
