/**
 * Search `--explain` — per-signal attribution formatter + accumulator helpers.
 * Pure logic, no DB / Bedrock.
 */
import { describe, expect, it } from "bun:test";
import {
  formatExplain,
  formatExplainList,
  snapshotScores,
  recordStageFactor,
  mergeExplain,
  finalizeExplain,
  type SearchExplain,
} from "../src/core/search/explain.ts";

describe("finalizeExplain", () => {
  it("fills base from final when nothing was accumulated", () => {
    const e = finalizeExplain(undefined, 3.5);
    expect(e).toEqual({ base: 3.5, final: 3.5 });
  });

  it("preserves accumulated factors and stamps final", () => {
    const e = finalizeExplain({ base: 1.0, backlink: 1.2 }, 1.32);
    expect(e.base).toBe(1.0);
    expect(e.backlink).toBe(1.2);
    expect(e.final).toBe(1.32);
  });
});

describe("recordStageFactor", () => {
  it("records only chunks whose score moved (factor != 1)", () => {
    const acc = new Map<string, Partial<SearchExplain>>();
    const before = snapshotScores([
      { chunkId: "a", score: 1.0 },
      { chunkId: "b", score: 2.0 },
    ]);
    // a boosted ×1.5, b unchanged.
    recordStageFactor(
      acc,
      before,
      [
        { chunkId: "a", score: 1.5 },
        { chunkId: "b", score: 2.0 },
      ],
      "backlink",
    );
    expect(acc.get("a")?.backlink).toBeCloseTo(1.5);
    expect(acc.get("b")).toBeUndefined();
  });

  it("ignores a zero/negative before-score (no divide-by-zero factor)", () => {
    const acc = new Map<string, Partial<SearchExplain>>();
    const before = snapshotScores([{ chunkId: "z", score: 0 }]);
    recordStageFactor(acc, before, [{ chunkId: "z", score: 5 }], "graph");
    expect(acc.get("z")).toBeUndefined();
  });
});

describe("mergeExplain", () => {
  it("merges patches without dropping earlier factors", () => {
    const acc = new Map<string, Partial<SearchExplain>>();
    mergeExplain(acc, "a", { base: 1.0, recency: 0.9 });
    mergeExplain(acc, "a", { title: 1.5 });
    expect(acc.get("a")).toEqual({ base: 1.0, recency: 0.9, title: 1.5 });
  });
});

describe("formatExplain", () => {
  it("renders base, each fired boost, and the final line", () => {
    const out = formatExplain(
      "people/alice",
      { base: 1.0, backlink: 1.2, title: 1.5, recency: 0.8, final: 1.44 },
      1,
    );
    expect(out).toContain("1. people/alice (score=1.44)");
    expect(out).toContain("base=1 (rrf+cosine)");
    expect(out).toContain("+ backlink ×1.2");
    expect(out).toContain("+ title ×1.5");
    expect(out).toContain("- recency ×0.8"); // <1 renders as a minus line
    expect(out).toContain("= final 1.44");
  });

  it("renders a reranker delta with a direction arrow", () => {
    const up = formatExplain("x", { base: 1, rerank_delta: 2, final: 1 }, 1);
    expect(up).toContain("↑ reranker rank +2");
    const down = formatExplain("y", { base: 1, rerank_delta: -1, final: 1 }, 1);
    expect(down).toContain("↓ reranker rank -1");
  });

  it("prints 'no boosts applied' when only base == final", () => {
    const out = formatExplain("plain", { base: 2, final: 2 }, 3);
    expect(out).toContain("no boosts applied");
    expect(out).toContain("= final 2");
  });
});

describe("formatExplainList", () => {
  it("returns a single-string breakdown for a list", () => {
    const out = formatExplainList([
      { sourcePath: "page://a", explain: { base: 1, backlink: 1.1, final: 1.1 }, score: 1.1 },
      { sourcePath: "page://b", score: 0.5 }, // no explain → falls back
    ]);
    expect(out).toContain("1. page://a");
    expect(out).toContain("+ backlink ×1.1");
    expect(out).toContain("2. page://b");
    expect(out.endsWith("\n")).toBe(true);
  });

  it("handles the empty list", () => {
    expect(formatExplainList([])).toBe("No results.\n");
  });
});
