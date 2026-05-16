/**
 * Per-IP token-bucket rate limiter.
 *
 * Pure in-memory; lost on container restart, which is fine — bursts on
 * boot don't accumulate. The bucket fills up to `capacity` and refills
 * `refillPerSecond` tokens per second.
 *
 * Thread-safety: Bun's HTTP handler is single-threaded JS so we don't
 * need locking around bucket reads/writes.
 */

export interface RateLimiterOptions {
  /** Max requests in a single burst. Default 30. */
  capacity?: number;
  /** Tokens added per second (steady-state rate). Default 1 (= 60/min). */
  refillPerSecond?: number;
  /** Hard cap on number of distinct keys held in memory. Default 10_000. */
  maxKeys?: number;
}

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  private capacity: number;
  private refillPerSecond: number;
  private maxKeys: number;
  private lastSweepMs = 0;

  constructor(opts: RateLimiterOptions = {}) {
    this.capacity = opts.capacity ?? 30;
    this.refillPerSecond = opts.refillPerSecond ?? 1;
    this.maxKeys = opts.maxKeys ?? 10_000;
  }

  /** Returns true if the request is allowed (and consumes 1 token). */
  allow(key: string, nowMs: number = Date.now()): boolean {
    // Periodic eviction: every 60s, drop fully-refilled (idle) buckets
    // so a long-running daemon doesn't accumulate an entry per unique
    // source IP forever (memory leak under public-CFip variety).
    if (nowMs - this.lastSweepMs > 60_000) {
      this.evictIdle(nowMs);
      this.lastSweepMs = nowMs;
    }
    let b = this.buckets.get(key);
    if (!b) {
      // If we're at the key cap, evict aggressively before adding.
      if (this.buckets.size >= this.maxKeys) this.evictIdle(nowMs);
      // If still at cap (very busy daemon), refuse new keys — better
      // to fail-closed on capacity than to OOM the process.
      if (this.buckets.size >= this.maxKeys) return false;
      b = { tokens: this.capacity, lastRefillMs: nowMs };
      this.buckets.set(key, b);
    }
    const elapsed = (nowMs - b.lastRefillMs) / 1000;
    b.tokens = Math.min(this.capacity, b.tokens + elapsed * this.refillPerSecond);
    b.lastRefillMs = nowMs;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  /**
   * Drop buckets whose tokens have refilled to capacity — they hold no
   * state worth keeping. Conservative: only evicts where the bucket
   * has been fully replenished, so an active limiter is never wiped.
   */
  private evictIdle(nowMs: number): void {
    for (const [k, b] of this.buckets) {
      const elapsed = (nowMs - b.lastRefillMs) / 1000;
      const refilled = b.tokens + elapsed * this.refillPerSecond;
      if (refilled >= this.capacity) this.buckets.delete(k);
    }
  }

  /** For diagnostics / tests. */
  size(): number {
    return this.buckets.size;
  }
}
