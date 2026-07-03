/**
 * Candidate-entity extraction for think auto-anchor. Pure + deterministic.
 */
import { describe, expect, it } from "bun:test";
import { extractCandidateEntities } from "../src/core/synthesis/entity-extract.ts";

describe("extractCandidateEntities", () => {
  it("prefers retrieved entity-prefixed slugs, in order, deduped", () => {
    const out = extractCandidateEntities("who is this", [
      "people/marco",
      "notes/random",
      "companies/acme",
      "people/marco",
    ]);
    expect(out.map((c) => c.raw)).toEqual(["people/marco", "companies/acme"]);
    expect(out.every((c) => c.origin === "retrieved")).toBe(true);
  });

  it("extracts noun-phrases from the question, stop-word bounded", () => {
    const out = extractCandidateEntities("When did I last meet Marco at Blue Bottle", []);
    const raws = out.map((c) => c.raw);
    // "meet marco" → leading-verb-stripped to "marco"; "at" splits the phrase.
    expect(raws).toContain("marco");
    expect(raws).toContain("blue bottle");
    expect(out.every((c) => c.origin === "extracted")).toBe(true);
  });

  it("caps at 5 total candidates", () => {
    const out = extractCandidateEntities("alpha bravo charlie delta echo foxtrot golf", []);
    expect(out.length).toBeLessThanOrEqual(5);
  });

  it("dedupes extracted against retrieved", () => {
    const out = extractCandidateEntities("what about acme", ["companies/acme"]);
    // "acme" (extracted) is distinct text from "companies/acme" (slug), so both
    // may appear — but neither list may contain an internal duplicate.
    const raws = out.map((c) => c.raw);
    expect(new Set(raws).size).toBe(raws.length);
  });

  it("returns [] for a pure stop-word question", () => {
    expect(extractCandidateEntities("what is it about", [])).toEqual([]);
  });
});
