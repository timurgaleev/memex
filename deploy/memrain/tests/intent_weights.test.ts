/**
 * Intent-weighted RRF — pure mapping tests (no Bedrock, no DB).
 */
import { describe, it, expect } from "bun:test";
import {
  intentRrfWeights,
  rrfWeightsForLists,
} from "../src/core/search/intent-weights.ts";
import { VALID_INTENTS, type Intent } from "../src/core/search/intent.ts";

describe("intentRrfWeights", () => {
  it("covers every valid intent with positive weights", () => {
    for (const intent of VALID_INTENTS) {
      const w = intentRrfWeights(intent);
      expect(w.vector).toBeGreaterThan(0);
      expect(w.keyword).toBeGreaterThan(0);
    }
  });

  it("leans keyword for exact and factual", () => {
    for (const intent of ["exact", "factual"] as Intent[]) {
      const w = intentRrfWeights(intent);
      expect(w.keyword).toBeGreaterThan(w.vector);
    }
  });

  it("leans vector for topic and personal", () => {
    for (const intent of ["topic", "personal"] as Intent[]) {
      const w = intentRrfWeights(intent);
      expect(w.vector).toBeGreaterThan(w.keyword);
    }
  });

  it("keeps howto balanced", () => {
    const w = intentRrfWeights("howto");
    expect(w.vector).toBe(w.keyword);
  });
});

describe("rrfWeightsForLists", () => {
  it("returns [vector, keyword...] aligned to list order", () => {
    // 1 vector list + 3 keyword lists (primary + 2 expansions).
    const weights = rrfWeightsForLists("topic", 3);
    const w = intentRrfWeights("topic");
    expect(weights).toEqual([w.vector, w.keyword, w.keyword, w.keyword]);
  });

  it("handles the no-expansion case (one keyword list)", () => {
    const weights = rrfWeightsForLists("exact", 1);
    const w = intentRrfWeights("exact");
    expect(weights).toEqual([w.vector, w.keyword]);
  });
});
