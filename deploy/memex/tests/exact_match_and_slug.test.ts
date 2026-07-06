/**
 * Exact-match boost (G19) + slug-candidate derivation — pure, no DB.
 */
import { describe, expect, it } from "bun:test";
import {
  exactMatchBoostForTaxonomy,
  exactMatchIndices,
} from "../src/core/search/intent-weights.ts";
import { slugCandidatesForPath } from "../src/core/search/page-slug.ts";

describe("exactMatchBoostForTaxonomy", () => {
  it("entity ×1.25, event ×1.10, others neutral (reference magnitudes)", () => {
    expect(exactMatchBoostForTaxonomy("entity")).toBe(1.25);
    expect(exactMatchBoostForTaxonomy("event")).toBe(1.1);
    expect(exactMatchBoostForTaxonomy("temporal")).toBe(1.0);
    expect(exactMatchBoostForTaxonomy("general")).toBe(1.0);
  });
});

describe("exactMatchIndices", () => {
  const cands = [
    { slugs: ["people/ada-lovelace"], title: "Ada Lovelace" },
    { slugs: ["companies/acme"], title: "Acme Corp" },
    { slugs: [], title: null },
  ];

  it("matches the kebab form of a spaced query against slug tails", () => {
    expect([...exactMatchIndices(cands, "ada lovelace")]).toEqual([0]);
  });

  it("matches an exact title (case-insensitive)", () => {
    expect([...exactMatchIndices(cands, "acme corp")]).toEqual([1]);
  });

  it("matches a full slug", () => {
    expect([...exactMatchIndices(cands, "companies/acme")]).toEqual([1]);
  });

  it("does not fire on partial overlap or empty queries", () => {
    expect(exactMatchIndices(cands, "ada").size).toBe(0);
    expect(exactMatchIndices(cands, "   ").size).toBe(0);
  });
});

describe("slugCandidatesForPath", () => {
  it("strips the page:// scheme (default tenant)", () => {
    expect(slugCandidatesForPath("page://people/alice", "default")).toEqual([
      "people/alice",
    ]);
  });

  it("adds the tenant-stripped form for non-default mirrors", () => {
    expect(slugCandidatesForPath("page://t1/people/alice", "t1")).toEqual([
      "t1/people/alice",
      "people/alice",
    ]);
  });

  it("strips page-truth:// the same way", () => {
    expect(slugCandidatesForPath("page-truth://people/alice", null)).toEqual([
      "people/alice",
    ]);
  });

  it("maps relative markdown files to their slug twin", () => {
    expect(slugCandidatesForPath("people/alice.md", null)).toEqual(["people/alice"]);
  });

  it("yields nothing for absolute paths and other schemes", () => {
    expect(slugCandidatesForPath("/abs/path.md", null)).toEqual([]);
    expect(slugCandidatesForPath("s3://bucket/x", null)).toEqual([]);
    expect(slugCandidatesForPath(null, null)).toEqual([]);
  });
});
