/**
 * Per-IP token-bucket rate limiter.
 *
 * Pure in-memory; lost on container restart, which is fine — bursts on
 * boot don't accumulate. The bucket fills up to `capacity` and refills
 * `refillPerSecond` tokens per second.
 *
 * Memory is bounded three ways so a long-running daemon never accumulates
 * an entry per unique source IP forever:
 *   1. a periodic sweep drops idle (fully-refilled) AND stale (untouched
 *      past `ttlMs`) buckets;
 *   2. a hard `maxKeys` cap;
 *   3. at the cap, the LEAST-RECENTLY-USED bucket is evicted to admit a new
 *      key — never fail-closed. Fail-closing on capacity would let a flood of
 *      distinct keys (e.g. a spray of source IPs) lock out every *new*
 *      legitimate caller once the table fills; LRU eviction keeps the active
 *      callers and recycles the stalest slot instead.
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
  /**
   * Drop a bucket untouched for this long, even if not yet fully refilled.
   * Bounds memory under a slow trickle of one-shot keys. Default 15 min.
   */
  ttlMs?: number;
}

interface Bucket {
  tokens: number;
  lastRefillMs: number;
  lastAccessMs: number;
}

export class RateLimiter {
  // Map insertion order is the recency order: the first entry is the
  // least-recently-used, the last is the most-recently-used. `allow()`
  // re-inserts a touched key to move it to the MRU end.
  private buckets = new Map<string, Bucket>();
  private capacity: number;
  private refillPerSecond: number;
  private maxKeys: number;
  private ttlMs: number;
  private lastSweepMs = 0;

  constructor(opts: RateLimiterOptions = {}) {
    this.capacity = opts.capacity ?? 30;
    this.refillPerSecond = opts.refillPerSecond ?? 1;
    this.maxKeys = opts.maxKeys ?? 10_000;
    this.ttlMs = opts.ttlMs ?? 900_000;
  }

  /** Returns true if the request is allowed (and consumes 1 token). */
  allow(key: string, nowMs: number = Date.now()): boolean {
    // Periodic eviction every 60s: drop idle + stale buckets.
    if (nowMs - this.lastSweepMs > 60_000) {
      this.evictStale(nowMs);
      this.lastSweepMs = nowMs;
    }

    let b = this.buckets.get(key);
    if (b) {
      // Touch: move to the MRU end so the LRU eviction order stays accurate.
      this.buckets.delete(key);
      this.buckets.set(key, b);
    } else {
      // New key. Make room if we're at the cap: a targeted sweep first, then
      // — if still full — evict the least-recently-used bucket. A new key is
      // ALWAYS admitted (never fail-closed), while memory stays bounded.
      if (this.buckets.size >= this.maxKeys) {
        this.evictStale(nowMs);
        if (this.buckets.size >= this.maxKeys) this.evictLru();
      }
      b = { tokens: this.capacity, lastRefillMs: nowMs, lastAccessMs: nowMs };
      this.buckets.set(key, b);
    }

    b.lastAccessMs = nowMs;
    const elapsed = (nowMs - b.lastRefillMs) / 1000;
    b.tokens = Math.min(this.capacity, b.tokens + elapsed * this.refillPerSecond);
    b.lastRefillMs = nowMs;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  /**
   * Drop buckets that are either fully refilled (idle — hold no state worth
   * keeping) or untouched past `ttlMs` (stale). Conservative on the idle
   * front: only evicts a fully-replenished bucket, so an actively-throttled
   * limiter is never wiped by the idle rule.
   */
  private evictStale(nowMs: number): void {
    for (const [k, b] of this.buckets) {
      const elapsed = (nowMs - b.lastRefillMs) / 1000;
      const refilled = b.tokens + elapsed * this.refillPerSecond;
      const idle = refilled >= this.capacity;
      const stale = nowMs - b.lastAccessMs > this.ttlMs;
      if (idle || stale) this.buckets.delete(k);
    }
  }

  /** Evict the single least-recently-used bucket (the first map entry). */
  private evictLru(): void {
    const oldest = this.buckets.keys().next().value;
    if (oldest !== undefined) this.buckets.delete(oldest);
  }

  /**
   * Seconds until the bucket holds at least one token again, for the
   * `Retry-After` header on a rejected request. READ-ONLY: projects the
   * bucket's token count without consuming a token or touching the LRU
   * recency order (no delete+set). Returns 1 for an untracked key or
   * whenever a token is already available; clamps to 3600 when the
   * limiter never refills (refillPerSecond <= 0) to avoid an Infinity
   * header, which is not a valid RFC 7231 delta-seconds value.
   */
  retryAfterSeconds(key: string, nowMs: number = Date.now()): number {
    const b = this.buckets.get(key);
    if (!b) return 1;
    const elapsed = (nowMs - b.lastRefillMs) / 1000;
    const projectedTokens = Math.min(
      this.capacity,
      b.tokens + elapsed * this.refillPerSecond,
    );
    if (projectedTokens >= 1) return 1;
    if (this.refillPerSecond <= 0) return 3600;
    return Math.max(1, Math.ceil((1 - projectedTokens) / this.refillPerSecond));
  }

  /** For diagnostics / tests. */
  size(): number {
    return this.buckets.size;
  }

  /** For diagnostics / tests: is this key currently tracked? */
  has(key: string): boolean {
    return this.buckets.has(key);
  }
}
