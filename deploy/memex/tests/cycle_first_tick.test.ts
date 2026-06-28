/**
 * firstTickDelayMs — the first cycle tick fires after a short boot-headroom
 * delay, not the full interval, so a brain redeployed more often than its
 * interval (the prod 6h default) still completes ticks instead of starving.
 */
import { describe, expect, it } from "bun:test";
import { firstTickDelayMs } from "../src/recipes/cycle.ts";

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
