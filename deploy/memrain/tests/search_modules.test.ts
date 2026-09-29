/**
 * Tests for the search sub-modules — pure logic, no Bedrock.
 *
 * Vector + keyword retrieval are tested via the full hybrid path in
 * the existing storage / health smoke; here we focus on dedup +
 * source-boost + intent heuristic + expansion shape.
 */
import { describe, expect, it } from "bun:test";
import { dedupByDocument } from "../src/core/search/dedup.ts";
import {
  applySourceBoost,
  type BoostablePayload,
} from "../src/core/search/source-boost.ts";
import { classifyIntent } from "../src/core/search/intent.ts";

describe("dedupByDocument", () => {
  it("keeps highest-scoring chunk per documentId", () => {
    const r = dedupByDocument([
      { chunkId: "a0", documentId: "d1", score: 1.0 },
      { chunkId: "a1", documentId: "d1", score: 0.5 }, // collapsed
      { chunkId: "b0", documentId: "d2", score: 0.9 },
    ]);
    expect(r.map((h) => h.chunkId)).toEqual(["a0", "b0"]);
  });

  it("respects maxPerDoc=2", () => {
    const r = dedupByDocument(
      [
        { chunkId: "a0", documentId: "d1", score: 1.0 },
        { chunkId: "a1", documentId: "d1", score: 0.8 },
        { chunkId: "a2", documentId: "d1", score: 0.6 }, // dropped
        { chunkId: "b0", documentId: "d2", score: 0.5 },
      ],
      { maxPerDoc: 2 },
    );
    expect(r.length).toBe(3);
    expect(r.map((h) => h.chunkId)).toEqual(["a0", "a1", "b0"]);
  });

  it("enabled=false is a no-op pass-through", () => {
    const input = [
      { chunkId: "a0", documentId: "d1", score: 1.0 },
      { chunkId: "a1", documentId: "d1", score: 0.5 },
    ];
    const r = dedupByDocument(input, { enabled: false });
    expect(r).toEqual(input);
  });
});

describe("applySourceBoost", () => {
  it("multiplies score by per-kind weight (vault=1.0, memory=0.7)", () => {
    const hits: { chunkId: string; documentId: string; score: number; payload: BoostablePayload }[] = [
      {
        chunkId: "v",
        documentId: "d1",
        score: 1.0,
        payload: { source_id: "vault", source_kind: "vault" },
      },
      {
        chunkId: "m",
        documentId: "d2",
        score: 1.0,
        payload: { source_id: "memory", source_kind: "memory" },
      },
    ];
    const out = applySourceBoost(hits);
    expect(out[0]!.score).toBeCloseTo(1.0);
    expect(out[1]!.score).toBeCloseTo(0.7);
  });

  it("perSourceId overrides the kind default", () => {
    const out = applySourceBoost(
      [
        {
          chunkId: "x",
          documentId: "d1",
          score: 1.0,
          payload: { source_id: "boosty", source_kind: "memory" },
        },
      ],
      { perSourceId: { boosty: 2.0 } },
    );
    expect(out[0]!.score).toBeCloseTo(2.0);
  });

  it("falls back to 1.0 when source is null", () => {
    const out = applySourceBoost([
      {
        chunkId: "n",
        documentId: "d",
        score: 0.5,
        payload: { source_id: null, source_kind: null },
      },
    ]);
    expect(out[0]!.score).toBeCloseTo(0.5);
  });
});

describe("classifyIntent — heuristic short-circuits", () => {
  it("quoted text → exact (no Bedrock call)", async () => {
    const r = await classifyIntent('"verbatim phrase"');
    expect(r).toBe("exact");
  });

  it("'how do I X' → howto (heuristic)", async () => {
    const r = await classifyIntent("how do I configure cloudflared");
    expect(r).toBe("howto");
  });

  it("'when did X' → factual (heuristic)", async () => {
    const r = await classifyIntent("when did ship");
    expect(r).toBe("factual");
  });

  it("empty → topic", async () => {
    const r = await classifyIntent("");
    expect(r).toBe("topic");
  });
});
