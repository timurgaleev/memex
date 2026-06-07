import { describe, it, expect } from "bun:test";
import { reciprocalRankFusion } from "../src/core/rrf.ts";

describe("reciprocalRankFusion", () => {
  it("returns a single ranked list of unique IDs", () => {
    const r = reciprocalRankFusion([["a", "b", "c"], ["b", "d"]]);
    const ids = r.map((x) => x.id);
    expect(new Set(ids).size).toBe(ids.length); // unique
    expect(ids).toContain("a");
    expect(ids).toContain("b");
    expect(ids).toContain("c");
    expect(ids).toContain("d");
  });

  it("ranks an item that appears in both lists higher than one in only one", () => {
    const r = reciprocalRankFusion([["a", "b"], ["a", "c"]]);
    const aScore = r.find((x) => x.id === "a")?.score ?? 0;
    const bScore = r.find((x) => x.id === "b")?.score ?? 0;
    const cScore = r.find((x) => x.id === "c")?.score ?? 0;
    expect(aScore).toBeGreaterThan(bScore);
    expect(aScore).toBeGreaterThan(cScore);
    expect(r[0]?.id).toBe("a");
  });

  it("respects rank — top-of-list contributes more than bottom", () => {
    const r = reciprocalRankFusion([["x", "y", "z"]]);
    expect(r[0]?.id).toBe("x");
    expect(r[1]?.id).toBe("y");
    expect(r[2]?.id).toBe("z");
    expect(r[0]?.score).toBeGreaterThan(r[1]?.score ?? 0);
  });

  it("uses the configured k smoothing constant", () => {
    const a = reciprocalRankFusion([["a"]], { k: 1 });
    const b = reciprocalRankFusion([["a"]], { k: 100 });
    // Larger k → smaller absolute contribution.
    expect((a[0]?.score ?? 0) > (b[0]?.score ?? 0)).toBe(true);
  });

  it("handles empty input gracefully", () => {
    expect(reciprocalRankFusion([])).toEqual([]);
    expect(reciprocalRankFusion([[]])).toEqual([]);
  });

  it("filters falsy ids", () => {
    // Cast through unknown so we can pass a rogue value into a strictly-typed array
    const r = reciprocalRankFusion([
      ["a", "" as unknown as string, "b"] as readonly string[],
    ]);
    expect(r.map((x) => x.id)).toEqual(["a", "b"]);
  });

  it("scales a list's contribution by its weight", () => {
    // Each id is rank-1 in its own list; weighting list 0 higher must win.
    const r = reciprocalRankFusion([["a"], ["b"]], { weights: [2, 1] });
    const aScore = r.find((x) => x.id === "a")?.score ?? 0;
    const bScore = r.find((x) => x.id === "b")?.score ?? 0;
    expect(aScore).toBeGreaterThan(bScore);
    expect(r[0]?.id).toBe("a");
  });

  it("can flip the winner purely via weights", () => {
    // Equal-weight: 'a' (rank 1 in list 0) ties/leads. Heavier list 1 lifts 'b'.
    const equal = reciprocalRankFusion([["a"], ["b"]]);
    expect(equal[0]?.id).toBe("a"); // first-inserted wins the tie
    const weighted = reciprocalRankFusion([["a"], ["b"]], { weights: [1, 3] });
    expect(weighted[0]?.id).toBe("b");
  });

  it("missing or short weights default to 1 (equal-weight RRF)", () => {
    const base = reciprocalRankFusion([["a", "b"], ["b", "c"]]);
    const withDefaults = reciprocalRankFusion([["a", "b"], ["b", "c"]], {
      weights: [1], // list 1 omitted → defaults to 1
    });
    expect(withDefaults).toEqual(base);
  });
});
