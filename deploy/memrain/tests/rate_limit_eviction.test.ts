/**
 * Eviction tests for the rate limiter — the in-memory bucket map
 * previously leaked one entry per unique source IP forever. Design:
 * a periodic sweep of idle (fully-refilled) + stale (TTL-expired)
 * buckets, a hard maxKeys cap, and — at the cap — LRU eviction so a
 * new key is always admitted (never fail-closed) while memory stays
 * bounded.
 */
import { describe, expect, test } from "bun:test";
import { RateLimiter } from "../src/mcp/rate_limit.ts";

describe("RateLimiter eviction", () => {
  test("idle buckets are evicted after the sweep interval", () => {
    const r = new RateLimiter({ capacity: 5, refillPerSecond: 5 });
    const t0 = 1000;
    // Hit ten distinct keys once each → ten buckets, each with 4
    // tokens left (1 consumed on creation).
    for (let i = 0; i < 10; i++) {
      expect(r.allow(`k${i}`, t0)).toBe(true);
    }
    expect(r.size()).toBe(10);
    // Wait 61s of simulated time. Each bucket would refill 5 tokens
    // (clamped at capacity=5), so every entry is fully refilled and
    // safely droppable.
    const tLate = t0 + 61_000;
    // Triggering eviction needs another allow() call — sweep runs
    // inline. Use a single fresh key that won't displace existing
    // ones beyond the sweep.
    r.allow("trigger", tLate);
    expect(r.size()).toBe(1); // only the trigger key survives
  });

  test("active buckets are NOT evicted by the sweep", () => {
    const r = new RateLimiter({ capacity: 5, refillPerSecond: 1 });
    const t0 = 1000;
    // Hit a key with EVERY token.
    for (let i = 0; i < 5; i++) {
      expect(r.allow("hot", t0)).toBe(true);
    }
    // hot bucket has 0 tokens. After 60s, only 60 * 1 = 60 tokens
    // refilled but clamped to capacity=5 — so it IS at-capacity again.
    // To test "active" we re-hit the key just before the sweep so
    // its tokens drop below capacity.
    const tLate = t0 + 60_500;
    r.allow("hot", tLate); // consumes again
    const tSweep = tLate + 100; // not enough time to refill
    r.allow("trigger", tSweep); // triggers sweep
    expect(r.size()).toBe(2); // hot survives, trigger added
  });

  test("at the cap, a new key evicts the LRU bucket and is admitted (never fail-closed)", () => {
    const r = new RateLimiter({ capacity: 5, refillPerSecond: 1, maxKeys: 3 });
    const t0 = 1000;
    expect(r.allow("a", t0)).toBe(true);
    expect(r.allow("b", t0)).toBe(true);
    expect(r.allow("c", t0)).toBe(true);
    // Fourth key — at the cap, all three are active (each capacity-1, no idle
    // to sweep). The new key must still be admitted by evicting the LRU ("a",
    // the oldest-touched), keeping memory bounded at maxKeys.
    expect(r.allow("d", t0)).toBe(true);
    expect(r.size()).toBe(3);
    expect(r.has("a")).toBe(false); // LRU evicted
    expect(r.has("b")).toBe(true);
    expect(r.has("c")).toBe(true);
    expect(r.has("d")).toBe(true);
  });

  test("touching a key makes it MRU so a later eviction drops a different one", () => {
    const r = new RateLimiter({ capacity: 5, refillPerSecond: 1, maxKeys: 2 });
    const t0 = 1000;
    expect(r.allow("a", t0)).toBe(true);
    expect(r.allow("b", t0)).toBe(true);
    // Re-touch "a" → it becomes the most-recently-used, so "b" is now the LRU.
    expect(r.allow("a", t0 + 10)).toBe(true);
    // New key "c" at the cap evicts the LRU = "b", not "a".
    expect(r.allow("c", t0 + 20)).toBe(true);
    expect(r.size()).toBe(2);
    expect(r.has("a")).toBe(true); // survived — was touched most recently
    expect(r.has("b")).toBe(false); // evicted — least recently used
    expect(r.has("c")).toBe(true);
  });

  test("stale (TTL-expired) buckets are swept even if never refilled", () => {
    // refillPerSecond:0 → a drained bucket NEVER refills, so the idle rule can
    // never drop it. Only the TTL/stale rule can — isolating that branch.
    const r = new RateLimiter({ capacity: 100, refillPerSecond: 0, ttlMs: 5_000 });
    const t0 = 1000;
    // Drain "slow" to 0; with zero refill it stays at 0 (never idle-droppable).
    for (let i = 0; i < 100; i++) expect(r.allow("slow", t0)).toBe(true);
    expect(r.has("slow")).toBe(true);
    // Past the 60s sweep interval AND past the 5s TTL since last access.
    r.allow("trigger", t0 + 61_000);
    expect(r.has("slow")).toBe(false); // dropped by the TTL rule alone
  });

  test("maxKeys eviction runs at capacity to make room", () => {
    const r = new RateLimiter({ capacity: 5, refillPerSecond: 5, maxKeys: 3 });
    const t0 = 1000;
    expect(r.allow("a", t0)).toBe(true);
    expect(r.allow("b", t0)).toBe(true);
    expect(r.allow("c", t0)).toBe(true);
    // Wait long enough for a, b, c to fully refill (they had
    // capacity - 1 = 4 tokens; need 1/5 = 0.2s to refill).
    const tLate = t0 + 1000;
    // New key triggers eviction first — should succeed because all
    // existing buckets are at capacity.
    expect(r.allow("d", tLate)).toBe(true);
    expect(r.size()).toBeLessThanOrEqual(3);
  });
});
