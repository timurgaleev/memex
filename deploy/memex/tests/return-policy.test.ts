/**
 * Adaptive return-sizing (return-policy.ts).
 */
import { describe, expect, it } from "bun:test";
import {
  resolveAdaptiveReturn,
  applyAdaptiveReturn,
  DEFAULT_ADAPTIVE_RETURN,
} from "../src/core/search/return-policy.ts";

const list = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

describe("resolveAdaptiveReturn", () => {
  it("undefined → defaults (disabled)", () => {
    expect(resolveAdaptiveReturn(undefined)).toEqual({ ...DEFAULT_ADAPTIVE_RETURN });
  });
  it("true → enabled, default caps", () => {
    expect(resolveAdaptiveReturn(true)).toMatchObject({ enabled: true, entityMax: 2, otherMax: 6 });
  });
  it("false → disabled", () => {
    expect(resolveAdaptiveReturn(false).enabled).toBe(false);
  });
  it("partial object overrides + clamps to >= 1", () => {
    expect(resolveAdaptiveReturn({ enabled: true, entityMax: 1, otherMax: 99 })).toMatchObject({
      enabled: true,
      entityMax: 1,
      otherMax: 99,
    });
    // entityMax 0 is below the min → falls back to the default (2).
    expect(resolveAdaptiveReturn({ enabled: true, entityMax: 0 }).entityMax).toBe(2);
  });
});

describe("applyAdaptiveReturn", () => {
  it("disabled → returns the full list, applied:false", () => {
    const r = applyAdaptiveReturn(list(8), "factual", resolveAdaptiveReturn(false));
    expect(r.kept.length).toBe(8);
    expect(r.decision.applied).toBe(false);
  });

  it("single-answer intent (factual) → entityMax cap", () => {
    const r = applyAdaptiveReturn(list(8), "factual", resolveAdaptiveReturn(true));
    expect(r.kept).toEqual([0, 1]); // entityMax = 2
    expect(r.decision).toMatchObject({ applied: true, cap: 2, kept: 2, total: 8 });
  });

  it("exact intent also gets the tight cap", () => {
    expect(applyAdaptiveReturn(list(8), "exact", resolveAdaptiveReturn(true)).kept.length).toBe(2);
  });

  it("broad intents (topic/howto/personal) → otherMax cap", () => {
    for (const intent of ["topic", "howto", "personal"] as const) {
      expect(applyAdaptiveReturn(list(20), intent, resolveAdaptiveReturn(true)).kept.length).toBe(6);
    }
  });

  it("minKeep failsafe: never empty when candidates exist", () => {
    const cfg = resolveAdaptiveReturn({ enabled: true, entityMax: 1, minKeep: 1 });
    expect(applyAdaptiveReturn(list(3), "factual", cfg).kept.length).toBe(1);
    expect(applyAdaptiveReturn([], "factual", cfg).kept.length).toBe(0);
  });

  it("cap larger than the list keeps everything", () => {
    expect(applyAdaptiveReturn(list(3), "topic", resolveAdaptiveReturn(true)).kept.length).toBe(3);
  });

  it("does not mutate the input array", () => {
    const input = list(8);
    applyAdaptiveReturn(input, "factual", resolveAdaptiveReturn(true));
    expect(input.length).toBe(8);
  });
});
