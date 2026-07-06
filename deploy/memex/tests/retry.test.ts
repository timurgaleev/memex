/**
 * withRetry / isRetryableConnError — connection-retry primitive for bulk writes.
 * Pure unit, no DB.
 */
import { describe, expect, it } from "bun:test";
import {
  isRetryableConnError,
  withRetry,
  computeNextDelay,
} from "../src/core/retry.ts";

describe("isRetryableConnError", () => {
  it("is true for transient connection failures", () => {
    expect(isRetryableConnError({ code: "ECONNRESET" })).toBe(true);
    expect(isRetryableConnError({ code: "08006" })).toBe(true);
    expect(isRetryableConnError({ code: "CONNECTION_ENDED" })).toBe(true);
    expect(isRetryableConnError({ code: "53300" })).toBe(true);
    expect(isRetryableConnError(new Error("Connection terminated unexpectedly"))).toBe(true);
  });

  it("is false for timeouts and logic errors", () => {
    expect(isRetryableConnError({ code: "57014" })).toBe(false); // statement_timeout
    expect(isRetryableConnError({ code: "55P03" })).toBe(false); // lock_timeout
    expect(isRetryableConnError({ code: "23505" })).toBe(false); // unique_violation
    expect(isRetryableConnError(new Error("bad params"))).toBe(false);
  });
});

describe("withRetry", () => {
  const fast = { maxRetries: 3, delayMs: 0, jitter: "none" as const };

  it("recovers a transient error then resolves", async () => {
    let n = 0;
    const r = await withRetry(async () => {
      n++;
      if (n < 3) throw { code: "ECONNRESET" };
      return "ok";
    }, fast);
    expect(r).toBe("ok");
    expect(n).toBe(3);
  });

  it("does not retry a non-retryable error", async () => {
    let n = 0;
    await expect(
      withRetry(async () => {
        n++;
        throw { code: "23505" };
      }, fast),
    ).rejects.toMatchObject({ code: "23505" });
    expect(n).toBe(1);
  });

  it("gives up after maxRetries on a persistent transient error", async () => {
    let n = 0;
    await expect(
      withRetry(async () => {
        n++;
        throw { code: "ECONNRESET" };
      }, fast),
    ).rejects.toMatchObject({ code: "ECONNRESET" });
    expect(n).toBe(4); // 1 initial + 3 retries
  });
});

describe("computeNextDelay decorrelated", () => {
  it("floors at base and caps at maxDelay", () => {
    expect(computeNextDelay("decorrelated", 0, 1000, 1000, 10_000, () => 0)).toBe(1000);
    expect(computeNextDelay("decorrelated", 0, 5000, 1000, 10_000, () => 1)).toBe(10_000);
  });
});
