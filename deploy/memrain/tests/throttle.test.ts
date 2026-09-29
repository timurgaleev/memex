/**
 * Tests for the throttle / preflight system.
 *
 * Covers: shouldProceed reasons (load, memory, concurrent, quiet-hours),
 * preflight + complete counter accounting, waitForCapacity timeout.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  shouldProceed,
  preflight,
  complete,
  getThrottleState,
  waitForCapacity,
  _resetForTest,
} from "../src/core/throttle.ts";

beforeEach(() => _resetForTest());
afterEach(() => _resetForTest());

// Pin "now" to a non-quiet-hours moment so the quiet-hours gate is
// off by default in these tests.
const NON_QUIET_NOW = new Date("2026-07-01T12:00:00Z"); // 14:00 CEST

describe("shouldProceed", () => {
  it("returns proceed=true when sensors are healthy", () => {
    const r = shouldProceed({
      now: NON_QUIET_NOW,
      systemSensors: { loadAvg1: 0.5, memoryRssMB: 100 },
    });
    expect(r.proceed).toBe(true);
    expect(r.reason).toBeNull();
  });

  it("declines on high load", () => {
    const r = shouldProceed({
      now: NON_QUIET_NOW,
      maxLoad: 2,
      systemSensors: { loadAvg1: 5, memoryRssMB: 100 },
    });
    expect(r.proceed).toBe(false);
    expect(r.reason).toBe("load");
  });

  it("declines on high memory", () => {
    const r = shouldProceed({
      now: NON_QUIET_NOW,
      maxMemoryMB: 100,
      systemSensors: { loadAvg1: 0.5, memoryRssMB: 200 },
    });
    expect(r.proceed).toBe(false);
    expect(r.reason).toBe("memory");
  });

  it("declines during the Berlin quiet window when respectQuietHours=true", () => {
    // 06:30 Berlin (CEST in summer = 04:30 UTC)
    const inside = new Date("2026-07-01T04:30:00Z");
    const r = shouldProceed({
      now: inside,
      systemSensors: { loadAvg1: 0.5, memoryRssMB: 100 },
    });
    expect(r.proceed).toBe(false);
    expect(r.reason).toBe("quiet-hours");
  });

  it("ignores quiet hours when respectQuietHours=false", () => {
    const inside = new Date("2026-07-01T04:30:00Z");
    const r = shouldProceed({
      now: inside,
      respectQuietHours: false,
      systemSensors: { loadAvg1: 0.5, memoryRssMB: 100 },
    });
    expect(r.proceed).toBe(true);
  });
});

describe("preflight + complete", () => {
  it("increments and decrements the active counter", () => {
    const a = preflight("embed.titan", {
      now: NON_QUIET_NOW,
      systemSensors: { loadAvg1: 0.5, memoryRssMB: 100 },
    });
    expect(a.proceed).toBe(true);
    expect(a.state.activeProcesses).toBe(1);
    expect(a.state.activeNames).toContain("embed.titan");

    complete("embed.titan");
    const after = getThrottleState({ now: NON_QUIET_NOW });
    expect(after.activeProcesses).toBe(0);
  });

  it("declines once concurrent cap is hit", () => {
    preflight("a", {
      now: NON_QUIET_NOW,
      maxConcurrent: 2,
      systemSensors: { loadAvg1: 0.5, memoryRssMB: 100 },
    });
    preflight("b", {
      now: NON_QUIET_NOW,
      maxConcurrent: 2,
      systemSensors: { loadAvg1: 0.5, memoryRssMB: 100 },
    });
    const c = preflight("c", {
      now: NON_QUIET_NOW,
      maxConcurrent: 2,
      systemSensors: { loadAvg1: 0.5, memoryRssMB: 100 },
    });
    expect(c.proceed).toBe(false);
    expect(c.reason).toBe("concurrent");
    expect(c.state.activeProcesses).toBe(2);
  });

  it("complete is a no-op when the name isn't active", () => {
    expect(() => complete("nope")).not.toThrow();
    const s = getThrottleState({ now: NON_QUIET_NOW });
    expect(s.activeProcesses).toBe(0);
  });

  it("preflight rejects empty name", () => {
    expect(() => preflight("")).toThrow();
  });
});

describe("waitForCapacity", () => {
  it("returns immediately when capacity is healthy", async () => {
    await waitForCapacity({
      now: NON_QUIET_NOW,
      systemSensors: { loadAvg1: 0.5, memoryRssMB: 100 },
    });
  });

  it("times out when the throttle never opens", async () => {
    await expect(
      waitForCapacity(
        {
          now: NON_QUIET_NOW,
          maxLoad: 1,
          systemSensors: { loadAvg1: 5, memoryRssMB: 100 },
        },
        { timeoutMs: 80, pollMs: 20 },
      ),
    ).rejects.toThrow(/timeout/);
  });
});
