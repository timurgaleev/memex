/**
 * Evidence + create_safety classification (memex arm-membership adaptation).
 */
import { describe, expect, it } from "bun:test";
import {
  classifyEvidence,
  createSafetyFor,
  stampEvidence,
  stampDefaultEvidence,
  type Stampable,
} from "../src/core/search/evidence.ts";

describe("classifyEvidence (arm membership)", () => {
  it("both arms (top rank by default) → high_vector_match", () => {
    expect(classifyEvidence({ inVector: true, inKeyword: true })).toBe("high_vector_match");
  });
  it("keyword arm only → keyword_exact", () => {
    expect(classifyEvidence({ inVector: false, inKeyword: true })).toBe("keyword_exact");
  });
  it("vector arm only → weak_semantic", () => {
    expect(classifyEvidence({ inVector: true, inKeyword: false })).toBe("weak_semantic");
  });
  it("neither arm → weak_semantic (safe default)", () => {
    expect(classifyEvidence({ inVector: false, inKeyword: false })).toBe("weak_semantic");
  });
});

describe("classifyEvidence (title + rank gate)", () => {
  it("title match → exact_title_match (arm-independent, wins over arms)", () => {
    expect(
      classifyEvidence({ inVector: false, inKeyword: false, titleMatch: true }),
    ).toBe("exact_title_match");
    expect(
      classifyEvidence({ inVector: true, inKeyword: true, titleMatch: true, isTopRank: false }),
    ).toBe("exact_title_match");
  });
  it("both arms but NOT top rank → keyword_exact (tightened, no false exists)", () => {
    expect(
      classifyEvidence({ inVector: true, inKeyword: true, isTopRank: false }),
    ).toBe("keyword_exact");
  });
  it("both arms AND top rank → high_vector_match", () => {
    expect(
      classifyEvidence({ inVector: true, inKeyword: true, isTopRank: true }),
    ).toBe("high_vector_match");
  });
  it("vector-only not-top → weak_semantic (no keyword corroboration)", () => {
    expect(
      classifyEvidence({ inVector: true, inKeyword: false, isTopRank: false }),
    ).toBe("weak_semantic");
  });
});

describe("createSafetyFor", () => {
  it("strong signals → exists", () => {
    expect(createSafetyFor("high_vector_match")).toBe("exists");
    expect(createSafetyFor("alias_hit")).toBe("exists");
    expect(createSafetyFor("exact_title_match")).toBe("exists");
  });
  it("keyword_exact → probable", () => {
    expect(createSafetyFor("keyword_exact")).toBe("probable");
  });
  it("weak_semantic → unknown", () => {
    expect(createSafetyFor("weak_semantic")).toBe("unknown");
  });
});

describe("stampEvidence", () => {
  it("stamps evidence + create_safety from arm sets + rank order", () => {
    const hits: Stampable[] = [
      { chunkId: "a" }, // both, index 0 (top rank)
      { chunkId: "b" }, // keyword only
      { chunkId: "c" }, // vector only
      { chunkId: "d" }, // neither
    ];
    stampEvidence(hits, new Set(["a", "c"]), new Set(["a", "b"]));
    expect(hits[0]).toMatchObject({ evidence: "high_vector_match", create_safety: "exists" });
    expect(hits[1]).toMatchObject({ evidence: "keyword_exact", create_safety: "probable" });
    expect(hits[2]).toMatchObject({ evidence: "weak_semantic", create_safety: "unknown" });
    expect(hits[3]).toMatchObject({ evidence: "weak_semantic", create_safety: "unknown" });
  });

  it("both-arms hit outside the rank band degrades to keyword_exact (no false exists)", () => {
    // RANK_BAND = 3, so a both-arms hit at index >= 3 loses `exists`.
    const hits: Stampable[] = [
      { chunkId: "r0" }, { chunkId: "r1" }, { chunkId: "r2" }, // fill the band
      { chunkId: "a" }, // both arms but index 3 (outside band) → keyword_exact
    ];
    stampEvidence(hits, new Set(["a"]), new Set(["a"]));
    expect(hits[3]).toMatchObject({ evidence: "keyword_exact", create_safety: "probable" });
  });

  it("both-arms hit INSIDE the rank band keeps high_vector_match (head protected)", () => {
    const hits: Stampable[] = [
      { chunkId: "r0" }, { chunkId: "r1" }, { chunkId: "a" }, // index 2, in band
    ];
    stampEvidence(hits, new Set(["a"]), new Set(["a"]));
    expect(hits[2]).toMatchObject({ evidence: "high_vector_match", create_safety: "exists" });
  });

  it("title-phrase match → exact_title_match at any rank", () => {
    const hits: Stampable[] = [
      { chunkId: "top" },
      { chunkId: "t", title: "Memex master plan" }, // index 1, title hit
    ];
    stampEvidence(hits, new Set(["top"]), new Set(["top"]), "master plan");
    expect(hits[1]).toMatchObject({ evidence: "exact_title_match", create_safety: "exists" });
  });

  it("is idempotent", () => {
    const hits: Stampable[] = [{ chunkId: "a" }];
    stampEvidence(hits, new Set(["a"]), new Set(["a"]));
    stampEvidence(hits, new Set(["a"]), new Set(["a"]));
    expect(hits[0]!.evidence).toBe("high_vector_match");
  });
});

describe("stampDefaultEvidence (cache-hit path)", () => {
  it("stamps the conservative default when no title match", () => {
    const hits: Stampable[] = [{ chunkId: "a" }, { chunkId: "b" }];
    stampDefaultEvidence(hits);
    for (const h of hits) {
      expect(h.evidence).toBe("weak_semantic");
      expect(h.create_safety).toBe("unknown");
    }
  });

  it("surfaces exact_title_match on a cached title hit (arm-blind but title-known)", () => {
    const hits: Stampable[] = [
      { chunkId: "a", title: "Memex master plan" },
      { chunkId: "b", title: "Unrelated page" },
    ];
    stampDefaultEvidence(hits, "memex master plan");
    expect(hits[0]).toMatchObject({ evidence: "exact_title_match", create_safety: "exists" });
    expect(hits[1]).toMatchObject({ evidence: "weak_semantic", create_safety: "unknown" });
  });
});
