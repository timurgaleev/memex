/**
 * Page salience scoring — pure deterministic [0..1] from tags + link-degree.
 */
import { describe, it, expect } from "bun:test";
import {
  computeSalience,
  parseHighEmotionTagsEnv,
  DEFAULT_HIGH_EMOTION_TAGS,
} from "../src/core/salience-score.ts";

describe("computeSalience", () => {
  it("scores 0.0 for an isolated page (no tags, no links)", () => {
    expect(computeSalience({ tags: [], linkDegree: 0 })).toBe(0);
  });

  it("applies the full 0.5 tag boost for any high-emotion tag (case-insensitive)", () => {
    expect(computeSalience({ tags: ["Family"], linkDegree: 0 })).toBeCloseTo(0.5, 6);
    expect(computeSalience({ tags: ["work", "WEDDING"], linkDegree: 0 })).toBeCloseTo(
      0.5,
      6,
    );
  });

  it("trims whitespace around tags before matching", () => {
    expect(computeSalience({ tags: ["  family  "], linkDegree: 0 })).toBeCloseTo(
      0.5,
      6,
    );
  });

  it("ignores tags not in the high-emotion set", () => {
    expect(computeSalience({ tags: ["work", "project", "ops"], linkDegree: 0 })).toBe(
      0,
    );
  });

  it("link-degree boost rises with degree and saturates at 0.5", () => {
    const d1 = computeSalience({ tags: [], linkDegree: 1 });
    const d5 = computeSalience({ tags: [], linkDegree: 5 });
    const d20 = computeSalience({ tags: [], linkDegree: 20 });
    const d100 = computeSalience({ tags: [], linkDegree: 100 });
    expect(d1).toBeGreaterThan(0);
    expect(d5).toBeGreaterThan(d1);
    expect(d20).toBeCloseTo(0.5, 6); // saturation point
    expect(d100).toBe(0.5); // clamped, never exceeds ceiling
  });

  it("sums both signals, clamped to [0..1]", () => {
    const s = computeSalience({ tags: ["health"], linkDegree: 100 });
    expect(s).toBe(1); // 0.5 tag + 0.5 degree (clamped)
    const mid = computeSalience({ tags: ["health"], linkDegree: 1 });
    expect(mid).toBeGreaterThan(0.5);
    expect(mid).toBeLessThan(1);
  });

  it("tolerates malformed degree (NaN / negative) as 0", () => {
    expect(computeSalience({ tags: [], linkDegree: Number.NaN })).toBe(0);
    expect(computeSalience({ tags: [], linkDegree: -5 })).toBe(0);
  });

  it("adds a small take-density boost (0.05/take, capped at 0.15)", () => {
    const base = computeSalience({ tags: [], linkDegree: 0 });
    const t1 = computeSalience({ tags: [], linkDegree: 0, takeCount: 1 });
    const t3 = computeSalience({ tags: [], linkDegree: 0, takeCount: 3 });
    const t10 = computeSalience({ tags: [], linkDegree: 0, takeCount: 10 });
    expect(base).toBe(0);
    expect(t1).toBeCloseTo(0.05, 6);
    expect(t3).toBeCloseTo(0.15, 6); // density saturates at 3 takes
    expect(t10).toBeCloseTo(0.15, 6); // capped, no further growth
  });

  it("adds an avg-weight term on top of density (max 0.05)", () => {
    // 1 take, full conviction: 0.05 density + 0.05 avg = 0.10
    const full = computeSalience({ tags: [], linkDegree: 0, takeCount: 1, takeAvgWeight: 1 });
    expect(full).toBeCloseTo(0.1, 6);
    // half conviction: 0.05 density + 0.025 avg
    const half = computeSalience({ tags: [], linkDegree: 0, takeCount: 1, takeAvgWeight: 0.5 });
    expect(half).toBeCloseTo(0.075, 6);
  });

  it("keeps link-degree as the base — takes never exceed a 0.2 lift", () => {
    // Max take signal: 10 takes at full conviction → 0.15 + 0.05 = 0.20
    const maxTake = computeSalience({
      tags: [],
      linkDegree: 0,
      takeCount: 10,
      takeAvgWeight: 1,
    });
    expect(maxTake).toBeCloseTo(0.2, 6);
  });

  it("ignores malformed take inputs (0 / NaN / negative count)", () => {
    expect(computeSalience({ tags: [], linkDegree: 0, takeCount: 0 })).toBe(0);
    expect(computeSalience({ tags: [], linkDegree: 0, takeCount: Number.NaN })).toBe(0);
    expect(computeSalience({ tags: [], linkDegree: 0, takeCount: -3 })).toBe(0);
    // negative avg weight contributes nothing beyond density
    expect(
      computeSalience({ tags: [], linkDegree: 0, takeCount: 1, takeAvgWeight: -1 }),
    ).toBeCloseTo(0.05, 6);
  });

  it("sums all three signals, clamped to [0..1]", () => {
    // 0.5 tag + 0.5 degree + take lift → clamped to 1
    const s = computeSalience({
      tags: ["health"],
      linkDegree: 100,
      takeCount: 5,
      takeAvgWeight: 1,
    });
    expect(s).toBe(1);
  });

  it("honours a custom high-emotion tag set override", () => {
    const custom = new Set(["deadline"]);
    expect(
      computeSalience({ tags: ["deadline"], linkDegree: 0 }, { highEmotionTags: custom }),
    ).toBeCloseTo(0.5, 6);
    // a default-set tag no longer matches under the override
    expect(
      computeSalience({ tags: ["family"], linkDegree: 0 }, { highEmotionTags: custom }),
    ).toBe(0);
  });
});

describe("parseHighEmotionTagsEnv", () => {
  it("returns null for empty / unset / whitespace-only input", () => {
    expect(parseHighEmotionTagsEnv(undefined)).toBeNull();
    expect(parseHighEmotionTagsEnv("")).toBeNull();
    expect(parseHighEmotionTagsEnv("  ,  , ")).toBeNull();
  });

  it("parses a comma-separated list into a lowercased set", () => {
    const set = parseHighEmotionTagsEnv("Deadline, Launch ,crunch");
    expect(set).not.toBeNull();
    expect(set!.has("deadline")).toBe(true);
    expect(set!.has("launch")).toBe(true);
    expect(set!.has("crunch")).toBe(true);
    expect(set!.has("Deadline")).toBe(false); // lowercased
  });
});

describe("DEFAULT_HIGH_EMOTION_TAGS", () => {
  it("contains the personal-life seed tags", () => {
    expect(DEFAULT_HIGH_EMOTION_TAGS.has("family")).toBe(true);
    expect(DEFAULT_HIGH_EMOTION_TAGS.has("health")).toBe(true);
  });
});
