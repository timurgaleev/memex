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
  it("both arms → high_vector_match", () => {
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
  it("stamps evidence + create_safety in place from the arm sets", () => {
    const hits: Stampable[] = [
      { chunkId: "a" }, // both
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

  it("is idempotent", () => {
    const hits: Stampable[] = [{ chunkId: "a" }];
    stampEvidence(hits, new Set(["a"]), new Set(["a"]));
    stampEvidence(hits, new Set(["a"]), new Set(["a"]));
    expect(hits[0]!.evidence).toBe("high_vector_match");
  });
});

describe("stampDefaultEvidence (cache-hit path)", () => {
  it("stamps the conservative default on every hit", () => {
    const hits: Stampable[] = [{ chunkId: "a" }, { chunkId: "b" }];
    stampDefaultEvidence(hits);
    for (const h of hits) {
      expect(h.evidence).toBe("weak_semantic");
      expect(h.create_safety).toBe("unknown");
    }
  });
});
