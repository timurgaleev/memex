/**
 * Recency multiplier — pure post-fusion signal tests (no DB, no Bedrock).
 */
import { describe, it, expect } from "bun:test";
import {
  recencyMultiplier,
  recencyMultiplierForPath,
  resolveRecencyConfig,
  resolveRecencyDecayMap,
  parseRecencyDecayEnv,
  RecencyDecayParseError,
  DEFAULT_RECENCY_FALLBACK,
} from "../src/core/search/recency.ts";

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

  it("treats halfLifeDays:0 as evergreen (always 1.0)", () => {
    expect(recencyMultiplier(iso(5000 * DAY), NOW, { halfLifeDays: 0, floor: 1 })).toBe(1);
  });
});

describe("per-prefix recency decay", () => {
  it("longest-prefix-match selects the config; unmatched → fallback", () => {
    expect(resolveRecencyConfig("daily/2026-06-09")).toEqual({ halfLifeDays: 14, floor: 0.4 });
    expect(resolveRecencyConfig("media/x/123")).toEqual({ halfLifeDays: 7, floor: 0.4 }); // longest match beats media/articles
    expect(resolveRecencyConfig("src/core/foo.ts")).toEqual(DEFAULT_RECENCY_FALLBACK);
    expect(resolveRecencyConfig(null)).toEqual(DEFAULT_RECENCY_FALLBACK);
  });

  it("evergreen prefix yields a 1.0 multiplier even for ancient content", () => {
    expect(recencyMultiplierForPath(iso(5000 * DAY), NOW, "concepts/ddd")).toBe(1);
  });

  it("daily/ decays much faster than an un-prefixed path of the same age", () => {
    const daily = recencyMultiplierForPath(iso(30 * DAY), NOW, "daily/log");
    const code = recencyMultiplierForPath(iso(30 * DAY), NOW, "src/x.ts");
    expect(daily).toBeLessThan(code); // 14d half-life + 0.4 floor vs 120d + 0.6
  });

  it("env override merges over defaults and wins", () => {
    const map = resolveRecencyDecayMap("daily/:60:0.9");
    expect(map["daily/"]).toEqual({ halfLifeDays: 60, floor: 0.9 });
    expect(map["concepts/"]).toEqual({ halfLifeDays: 0, floor: 1 }); // default preserved
  });

  it("env parser fails loud on malformed input", () => {
    expect(() => parseRecencyDecayEnv("daily/:7")).toThrow(RecencyDecayParseError);
    expect(() => parseRecencyDecayEnv("daily/:7:2")).toThrow(/floor/); // floor > 1
    expect(() => parseRecencyDecayEnv("daily/:-7:0.4")).toThrow(/halfLifeDays/);
    expect(() => parseRecencyDecayEnv(":7:0.4")).toThrow(/prefix|must be/);
  });

  it("empty env → empty map (no override)", () => {
    expect(parseRecencyDecayEnv(undefined)).toEqual({});
    expect(parseRecencyDecayEnv("")).toEqual({});
  });
});
