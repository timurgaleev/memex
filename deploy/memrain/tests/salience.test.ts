/**
 * Salience multiplier — pure frontmatter-driven importance signal.
 */
import { describe, it, expect } from "bun:test";
import { salienceMultiplier } from "../src/core/search/salience.ts";

describe("salienceMultiplier", () => {
  it("is neutral (1.0) when frontmatter is absent or malformed", () => {
    expect(salienceMultiplier(undefined)).toBe(1);
    expect(salienceMultiplier(null)).toBe(1);
    expect(salienceMultiplier("not-an-object")).toBe(1);
    expect(salienceMultiplier({})).toBe(1);
    expect(salienceMultiplier({ weight: "abc" })).toBe(1);
  });

  it("applies an explicit numeric weight, clamped to [0.5, 2.0]", () => {
    expect(salienceMultiplier({ weight: 1.5 })).toBe(1.5);
    expect(salienceMultiplier({ weight: "1.25" })).toBe(1.25);
    expect(salienceMultiplier({ weight: 9 })).toBe(2.0); // clamped up-bound
    expect(salienceMultiplier({ weight: 0.1 })).toBe(0.5); // clamped low-bound
  });

  it("floors at 1.3 when pinned (various truthy spellings)", () => {
    expect(salienceMultiplier({ pinned: true })).toBe(1.3);
    expect(salienceMultiplier({ pinned: "true" })).toBe(1.3);
    expect(salienceMultiplier({ pinned: 1 })).toBe(1.3);
  });

  it("does not demote a pinned doc that also has a higher weight", () => {
    expect(salienceMultiplier({ pinned: true, weight: 1.8 })).toBe(1.8);
  });

  it("pinned floors a low weight up to 1.3", () => {
    expect(salienceMultiplier({ pinned: true, weight: 0.6 })).toBe(1.3);
  });

  it("ignores a pinned:false / absent pin", () => {
    expect(salienceMultiplier({ pinned: false })).toBe(1);
    expect(salienceMultiplier({ pinned: "no" })).toBe(1);
  });
});
