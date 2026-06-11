/**
 * Near-duplicate dedup (Jaccard text similarity) + threshold resolution.
 */
import { describe, expect, it } from "bun:test";
import {
  dedupByTextSimilarity,
  resolveNearDupThreshold,
  NearDupThresholdParseError,
  type ChunkScore,
} from "../src/core/search/dedup.ts";

type P = { content?: string };
const hit = (chunkId: string, content: string | undefined, score = 1): ChunkScore<P> => ({
  chunkId,
  documentId: chunkId.replace(/_c\d+$/, ""),
  score,
  payload: { content },
});

// >= MIN_DEDUP_TOKENS (12) words so the near-dup judgment actually runs.
const LONG_A = "the quick brown fox jumps over the lazy dog while the sun sets slowly over green hills";
const LONG_A_NEARDUP = `${LONG_A} again today`; // ~identical word set
const LONG_DISTINCT = "zigbee pairing home assistant configuration setup guide steps for a new smart device tonight";

describe("dedupByTextSimilarity", () => {
  it("drops a near-identical lower-ranked hit, keeps the first", () => {
    const hits = [
      hit("doc_a_c0", LONG_A),
      hit("doc_b_c0", LONG_A_NEARDUP), // near-dup of a
      hit("doc_c_c0", LONG_DISTINCT),
    ];
    expect(dedupByTextSimilarity(hits, 0.85).map((h) => h.chunkId)).toEqual([
      "doc_a_c0",
      "doc_c_c0",
    ]);
  });

  it("keeps two long docs that overlap vocabulary but are below threshold", () => {
    const hits = [
      hit("doc_a_c0", "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima"),
      // shares 6 of 12 words → jaccard 6/18 = 0.33, well under 0.85
      hit("doc_b_c0", "alpha bravo charlie delta echo foxtrot mike november oscar papa quebec romeo"),
    ];
    expect(dedupByTextSimilarity(hits, 0.85).length).toBe(2);
  });

  it("never drops a SHORT hit even if identical (min-token floor)", () => {
    const hits = [hit("doc_a_c0", "one two three"), hit("doc_b_c0", "one two three")];
    // Both are 3 words, below the 12-token floor → neither is judged a near-dup.
    expect(dedupByTextSimilarity(hits, 0.85).length).toBe(2);
  });

  it("preserves rank order (greedy, first/higher-scored occurrence wins)", () => {
    const hits = [
      hit("doc_a_c0", LONG_A, 3),
      hit("doc_b_c0", LONG_DISTINCT, 2),
      hit("doc_c_c0", LONG_A_NEARDUP, 1), // near-dup of a, lower score
    ];
    expect(dedupByTextSimilarity(hits, 0.85).map((h) => h.chunkId)).toEqual([
      "doc_a_c0",
      "doc_b_c0",
    ]);
  });

  it("never drops an empty / contentless hit", () => {
    const hits = [hit("doc_a_c0", ""), hit("doc_b_c0", ""), hit("doc_c_c0", undefined)];
    expect(dedupByTextSimilarity(hits, 0.85).length).toBe(3);
  });

  it("a threshold > 1.0 keeps everything (the disable switch)", () => {
    const hits = [hit("doc_a_c0", LONG_A), hit("doc_b_c0", LONG_A_NEARDUP)];
    expect(dedupByTextSimilarity(hits, 1.01).length).toBe(2);
  });

  it("does not mutate the input array", () => {
    const hits = [hit("doc_a_c0", LONG_A), hit("doc_b_c0", LONG_A_NEARDUP)];
    dedupByTextSimilarity(hits, 0.85);
    expect(hits.length).toBe(2);
  });
});

describe("resolveNearDupThreshold", () => {
  it("defaults to 0.85 when unset", () => {
    expect(resolveNearDupThreshold(undefined)).toBe(0.85);
    expect(resolveNearDupThreshold("")).toBe(0.85);
  });
  it("parses a valid threshold", () => {
    expect(resolveNearDupThreshold("0.9")).toBe(0.9);
    expect(resolveNearDupThreshold("2")).toBe(2); // > 1 disables the stage
  });
  it("throws on malformed input", () => {
    expect(() => resolveNearDupThreshold("0.9x")).toThrow(NearDupThresholdParseError);
    expect(() => resolveNearDupThreshold("-1")).toThrow(NearDupThresholdParseError);
    expect(() => resolveNearDupThreshold("abc")).toThrow(NearDupThresholdParseError);
  });
});
