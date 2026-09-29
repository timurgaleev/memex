/**
 * Retry-After computation for the rate limiter. The 429 path sets a
 * `Retry-After` header (RFC 7231 delta-seconds) from
 * `retryAfterSeconds()`, which must project the bucket's token count
 * WITHOUT consuming a token or disturbing the LRU recency order.
 */
import { describe, expect, test } from "bun:test";
import { RateLimiter } from "../src/mcp/rate_limit.ts";
import { makeMcpHandler } from "../src/mcp/http_transport.ts";

describe("RateLimiter retryAfterSeconds", () => {
  test("after the token is consumed, returns ceil((1 - tokens) / refill)", () => {
    const r = new RateLimiter({ capacity: 1, refillPerSecond: 0.5 });
    const t0 = 1000;
    expect(r.allow("k", t0)).toBe(true); // consumes the only token → 0 left
    // 0 tokens, refill 0.5/s → need 1 token → ceil(1 / 0.5) = 2 seconds.
    expect(r.retryAfterSeconds("k", t0)).toBe(2);
  });

  test("an untracked key returns 1", () => {
    const r = new RateLimiter({ capacity: 1, refillPerSecond: 0.5 });
    expect(r.retryAfterSeconds("never-seen", 1000)).toBe(1);
  });

  test("a non-refilling bucket (refillPerSecond 0) clamps to 3600", () => {
    const r = new RateLimiter({ capacity: 1, refillPerSecond: 0 });
    const t0 = 1000;
    expect(r.allow("k", t0)).toBe(true); // drains to 0; never refills
    expect(r.retryAfterSeconds("k", t0)).toBe(3600);
  });

  test("is read-only — does not consume a token or move recency", () => {
    const r = new RateLimiter({ capacity: 1, refillPerSecond: 0.5 });
    const t0 = 1000;
    expect(r.allow("k", t0)).toBe(true); // 0 tokens now
    // Probing retry-after must not mutate state: the bucket is still empty,
    // so a subsequent allow() at the same instant is still rejected.
    expect(r.retryAfterSeconds("k", t0)).toBe(2);
    expect(r.retryAfterSeconds("k", t0)).toBe(2); // stable across calls
    expect(r.allow("k", t0)).toBe(false); // still no token to consume
  });
});

describe("HTTP 429 carries an integer Retry-After", () => {
  test("a throttled request gets 429 + Retry-After >= 1", async () => {
    const limiter = new RateLimiter({ capacity: 1, refillPerSecond: 0.5 });
    const handler = makeMcpHandler({
      storage: { engine: () => ({ query: async () => ({ rows: [] }) }) } as never,
      publicRateLimiter: limiter,
      clientKey: () => "fixed-key",
    });
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
    const mk = () =>
      new Request("http://x/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });

    const first = await handler(mk(), { isPublic: true });
    expect(first.status).toBe(200); // consumes the only token
    const second = await handler(mk(), { isPublic: true });
    expect(second.status).toBe(429);
    const retryAfter = second.headers.get("Retry-After");
    expect(retryAfter).not.toBeNull();
    const seconds = Number(retryAfter);
    expect(Number.isInteger(seconds)).toBe(true);
    expect(seconds).toBeGreaterThanOrEqual(1);
  });
});
