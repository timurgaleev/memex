/**
 * withRetry / isRetryableConnError — connection-retry primitive for bulk writes,
 * plus withDeadlockRetry, the transaction-level envelope for a deadlock victim.
 * Pure unit, no DB.
 */
import { describe, expect, it } from "bun:test";
import {
  isRetryableConnError,
  isDeadlockError,
  withRetry,
  withDeadlockRetry,
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

describe("isDeadlockError", () => {
  it("is true only for a deadlock victim", () => {
    expect(isDeadlockError({ code: "40P01" })).toBe(true);
    expect(isDeadlockError(new Error("deadlock detected"))).toBe(true);
    expect(isDeadlockError({ code: "40001" })).toBe(false); // serialization failure
    expect(isDeadlockError({ code: "55P03" })).toBe(false); // lock_timeout
    expect(isDeadlockError(new Error("could not obtain lock"))).toBe(false);
  });
});

describe("withDeadlockRetry", () => {
  const fast = { attempts: 3, rng: () => 0 };

  it("re-runs the transaction Postgres aborted as the victim", async () => {
    let n = 0;
    const r = await withDeadlockRetry(async () => {
      n++;
      if (n === 1) throw { code: "40P01", message: "deadlock detected" };
      return "committed";
    }, fast);
    expect(r).toBe("committed");
    expect(n).toBe(2);
  });

  it("does not re-run any other failure", async () => {
    let n = 0;
    await expect(
      withDeadlockRetry(async () => {
        n++;
        throw { code: "23505" };
      }, fast),
    ).rejects.toMatchObject({ code: "23505" });
    expect(n).toBe(1);
  });

  it("gives up after the attempt budget", async () => {
    let n = 0;
    await expect(
      withDeadlockRetry(async () => {
        n++;
        throw { code: "40P01" };
      }, fast),
    ).rejects.toMatchObject({ code: "40P01" });
    expect(n).toBe(3);
  });
});
