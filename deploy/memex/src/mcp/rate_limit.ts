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
}

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  private capacity: number;
  private refillPerSecond: number;

  constructor(opts: RateLimiterOptions = {}) {
    this.capacity = opts.capacity ?? 30;
    this.refillPerSecond = opts.refillPerSecond ?? 1;
  }

  /** Returns true if the request is allowed (and consumes 1 token). */
  allow(key: string, nowMs: number = Date.now()): boolean {
    let b = this.buckets.get(key);
    if (!b) {
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

  /** For diagnostics / tests. */
  size(): number {
    return this.buckets.size;
  }
}
