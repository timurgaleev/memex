/**
 * eval-probe per-run cost cap: --max-usd converts to an effective query limit,
 * and the tighter of (limit, budget-cap) wins.
 */
import { describe, expect, it } from "bun:test";
import { effectiveProbeLimit, PER_QUERY_USD_ESTIMATE } from "../src/commands/eval-probe.ts";

describe("effectiveProbeLimit", () => {
  it("returns the explicit limit when no USD cap is set", () => {
    expect(effectiveProbeLimit(50, undefined)).toBe(50);
    expect(effectiveProbeLimit(undefined, undefined)).toBeUndefined();
  });

  it("converts a USD cap to a query count", () => {
    // 0.01 / 0.001 = 10 queries.
    expect(effectiveProbeLimit(undefined, 0.01)).toBe(Math.floor(0.01 / PER_QUERY_USD_ESTIMATE));
  });

  it("takes the tighter of an explicit limit and the USD-derived cap", () => {
    expect(effectiveProbeLimit(100, 0.01)).toBe(10); // budget wins
    expect(effectiveProbeLimit(5, 0.05)).toBe(5); // explicit limit wins
  });

  it("never returns below 1 for a tiny positive budget", () => {
    expect(effectiveProbeLimit(undefined, 0.0000001)).toBe(1);
  });
});
