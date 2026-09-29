/**
 * Type-diversity dedup layer — pure, no DB.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
  enforceTypeDiversity,
  pageTypeOf,
  resolveMaxTypeRatio,
  TypeRatioParseError,
  type ChunkScore,
} from "../src/core/search/dedup.ts";

const hit = (
  id: string,
  sourcePath: string,
  score: number,
  type?: string,
): ChunkScore<{ sourcePath: string; frontmatter?: unknown }> => ({
  chunkId: id,
  documentId: `doc_${id}`,
  score,
  payload: { sourcePath, ...(type ? { frontmatter: { type } } : {}) },
});

describe("pageTypeOf", () => {
  it("prefers frontmatter.type", () => {
    expect(pageTypeOf({ frontmatter: { type: "person" }, sourcePath: "chat/x" })).toBe("person");
  });
  it("falls back to the first path segment, scheme-stripped", () => {
    expect(pageTypeOf({ sourcePath: "people/alice.md" })).toBe("people");
    expect(pageTypeOf({ sourcePath: "page://daily/2026-07-01" })).toBe("daily");
    expect(pageTypeOf({ sourcePath: "page-truth://people/alice" })).toBe("people");
  });
  it("segment-less paths group under 'note'", () => {
    expect(pageTypeOf({ sourcePath: "readme.md" })).toBe("note");
    expect(pageTypeOf(undefined)).toBe("note");
  });
});

describe("enforceTypeDiversity", () => {
  it("caps one type at ceil(n × ratio), keeping the strongest in rank order", () => {
    const hits = [
      hit("c1", "chat/a", 10),
      hit("c2", "chat/b", 9),
      hit("c3", "chat/c", 8),
      hit("c4", "chat/d", 7),
      hit("p1", "people/x", 6),
      hit("w1", "writing/y", 5),
    ];
    // n=6, ratio 0.6 → maxPerType 4: chat keeps 4 here; shrink ratio to bite.
    const kept = enforceTypeDiversity(hits, 0.5); // maxPerType 3
    expect(kept.map((h) => h.chunkId)).toEqual(["c1", "c2", "c3", "p1", "w1"]);
  });

  it("ratio >= 1 disables the layer", () => {
    const hits = [hit("a", "chat/a", 2), hit("b", "chat/b", 1)];
    expect(enforceTypeDiversity(hits, 1)).toHaveLength(2);
  });

  it("always keeps at least one per type (floor 1)", () => {
    const hits = [hit("a", "chat/a", 2), hit("b", "people/b", 1)];
    const kept = enforceTypeDiversity(hits, 0.1);
    expect(kept.map((h) => h.chunkId)).toEqual(["a", "b"]);
  });
});

describe("MEMEX_MAX_TYPE_RATIO", () => {
  const savedEnv = process.env.MEMEX_MAX_TYPE_RATIO;
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.MEMEX_MAX_TYPE_RATIO;
    else process.env.MEMEX_MAX_TYPE_RATIO = savedEnv;
  });

  it("defaults to 0.6", () => {
    expect(resolveMaxTypeRatio(undefined)).toBe(0.6);
  });
  it("accepts an override and fails loud on garbage", () => {
    expect(resolveMaxTypeRatio("0.4")).toBe(0.4);
    expect(resolveMaxTypeRatio("1")).toBe(1);
    expect(() => resolveMaxTypeRatio("lots")).toThrow(TypeRatioParseError);
    expect(() => resolveMaxTypeRatio("0")).toThrow(TypeRatioParseError);
  });
});
