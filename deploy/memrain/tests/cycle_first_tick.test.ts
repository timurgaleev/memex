/**
 * firstTickDelayMs — the first cycle tick fires after a short boot-headroom
 * delay, not the full interval, so a brain redeployed more often than its
 * interval (the prod 6h default) still completes ticks instead of starving.
 */
import { describe, expect, it } from "bun:test";
import { firstTickDelayMs, nextTickDelayMs } from "../src/recipes/cycle.ts";

describe("firstTickDelayMs", () => {
  it("caps a long interval at the 60s boot-headroom delay", () => {
    expect(firstTickDelayMs(6 * 60 * 60 * 1000)).toBe(60_000); // 6h interval → 60s first tick
  });

  it("keeps a sub-minute interval's own cadence", () => {
    expect(firstTickDelayMs(5_000)).toBe(5_000);
  });

  it("never returns a negative delay", () => {
    expect(firstTickDelayMs(-1)).toBe(0);
  });
});

describe("nextTickDelayMs", () => {
  it("a tick that ran re-arms at the full interval", () => {
    expect(nextTickDelayMs(6 * 60 * 60 * 1000, false)).toBe(6 * 60 * 60 * 1000);
  });

  it("a skipped tick retries within the 5-min lock TTL, not the full interval", () => {
    expect(nextTickDelayMs(6 * 60 * 60 * 1000, true)).toBe(5 * 60 * 1000); // min(6h, 5min)
  });

  it("a sub-TTL interval keeps its own cadence on skip", () => {
    expect(nextTickDelayMs(60_000, true)).toBe(60_000); // min(60s, 5min)
  });
});
