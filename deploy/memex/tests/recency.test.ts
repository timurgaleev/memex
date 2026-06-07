/**
 * Recency multiplier — pure post-fusion signal tests (no DB, no Bedrock).
 */
import { describe, it, expect } from "bun:test";
import { recencyMultiplier } from "../src/core/search/recency.ts";

const DAY = 86_400_000;
const NOW = 1_700_000_000_000; // fixed reference instant
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

describe("recencyMultiplier", () => {
  it("returns 1.0 for a just-updated document", () => {
    expect(recencyMultiplier(iso(0), NOW)).toBeCloseTo(1, 5);
  });

  it("returns floor + (1-floor)/2 at one half-life", () => {
    const m = recencyMultiplier(iso(120 * DAY), NOW, {
      halfLifeDays: 120,
      floor: 0.6,
    });
    expect(m).toBeCloseTo(0.6 + 0.4 / 2, 5); // 0.8
  });

  it("decays monotonically toward the floor but never below it", () => {
    const young = recencyMultiplier(iso(10 * DAY), NOW);
    const mid = recencyMultiplier(iso(120 * DAY), NOW);
    const old = recencyMultiplier(iso(2000 * DAY), NOW);
    expect(young).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(old);
    expect(old).toBeGreaterThanOrEqual(0.6);
    expect(old).toBeLessThan(0.62); // essentially at the floor
  });

  it("is neutral (1.0) for null / unparseable / future timestamps", () => {
    expect(recencyMultiplier(null, NOW)).toBe(1);
    expect(recencyMultiplier(undefined, NOW)).toBe(1);
    expect(recencyMultiplier("not-a-date", NOW)).toBe(1);
    expect(recencyMultiplier(iso(-5 * DAY), NOW)).toBe(1); // 5 days in the future
  });

  it("respects custom half-life and floor", () => {
    const m = recencyMultiplier(iso(30 * DAY), NOW, {
      halfLifeDays: 30,
      floor: 0,
    });
    expect(m).toBeCloseTo(0.5, 5); // floor 0, one half-life → 0.5
  });
});
