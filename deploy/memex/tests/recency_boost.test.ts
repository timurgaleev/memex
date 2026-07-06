/**
 * Hyperbolic recency BOOST (G20 reference parity) — pure math + env parsing.
 * The penalty-only decay keeps its own tests in recency.test.ts.
 */
import { describe, expect, it } from "bun:test";
import {
  recencyBoostMultiplierForPath,
  parseRecencyBoostEnv,
  resolveRecencyBoostMap,
  DEFAULT_RECENCY_BOOST,
  DEFAULT_RECENCY_BOOST_FALLBACK,
  RecencyDecayParseError,
} from "../src/core/search/recency.ts";

const DAY = 86_400_000;
const NOW = Date.parse("2026-07-01T00:00:00Z");
const iso = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString();

describe("recencyBoostMultiplierForPath", () => {
  it("boosts fresh content up to 1 + coefficient at age 0", () => {
    // daily/: halfLife 14, coefficient 1.5 → age 0 ⇒ ×2.5
    const f = recencyBoostMultiplierForPath(iso(0), NOW, "daily/2026-07-01", "on");
    expect(f).toBeCloseTo(2.5, 5);
  });

  it("halves the contribution at the half-life", () => {
    // age 14d on daily/ → 1 + 1.5 × 14/(14+14) = 1.75
    const f = recencyBoostMultiplierForPath(iso(14), NOW, "daily/x", "on");
    expect(f).toBeCloseTo(1.75, 5);
  });

  it("'strong' multiplies the contribution ×1.5", () => {
    const on = recencyBoostMultiplierForPath(iso(0), NOW, "daily/x", "on");
    const strong = recencyBoostMultiplierForPath(iso(0), NOW, "daily/x", "strong");
    expect(strong).toBeCloseTo(1 + (on - 1) * 1.5, 5);
  });

  it("evergreen prefixes never boost", () => {
    expect(recencyBoostMultiplierForPath(iso(0), NOW, "concepts/x", "strong")).toBe(1);
  });

  it("unmatched paths use the fallback config", () => {
    const f = recencyBoostMultiplierForPath(iso(0), NOW, "src/thing.ts", "on");
    expect(f).toBeCloseTo(1 + DEFAULT_RECENCY_BOOST_FALLBACK.coefficient, 5);
  });

  it("page:// mirrors match the same prefix as their file twin", () => {
    const file = recencyBoostMultiplierForPath(iso(3), NOW, "daily/x", "on");
    const page = recencyBoostMultiplierForPath(iso(3), NOW, "page://daily/x", "on");
    expect(page).toBeCloseTo(file, 10);
  });

  it("missing or bad dates are neutral", () => {
    expect(recencyBoostMultiplierForPath(null, NOW, "daily/x", "on")).toBe(1);
    expect(recencyBoostMultiplierForPath("garbage", NOW, "daily/x", "on")).toBe(1);
  });

  it("a boosted fresh hit can exceed the old ×1.0 ceiling (the G20 point)", () => {
    const f = recencyBoostMultiplierForPath(iso(1), NOW, "media/x/post", "strong");
    expect(f).toBeGreaterThan(1.5);
  });
});

describe("MEMEX_RECENCY_BOOST env parsing", () => {
  it("parses prefix:halfLife:coefficient triples", () => {
    const m = parseRecencyBoostEnv("daily/:7:2.0,custom/:30:1");
    expect(m["daily/"]).toEqual({ halfLifeDays: 7, coefficient: 2.0 });
    expect(m["custom/"]).toEqual({ halfLifeDays: 30, coefficient: 1 });
  });

  it("merges over defaults (env wins)", () => {
    const m = resolveRecencyBoostMap("daily/:7:2.0");
    expect(m["daily/"]).toEqual({ halfLifeDays: 7, coefficient: 2.0 });
    expect(m["people/"]).toEqual(DEFAULT_RECENCY_BOOST["people/"]);
  });

  it("fails loud on malformed entries", () => {
    expect(() => parseRecencyBoostEnv("daily/:x:1")).toThrow(RecencyDecayParseError);
    expect(() => parseRecencyBoostEnv("nocolons")).toThrow(RecencyDecayParseError);
    expect(() => parseRecencyBoostEnv(":7:1")).toThrow(RecencyDecayParseError);
  });
});
