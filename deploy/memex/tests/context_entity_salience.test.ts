/**
 * Push-based context — pure entity-salience extraction (zero-DB, zero-LLM).
 */
import { describe, expect, it } from "bun:test";
import {
  extractCandidates,
  extractCandidatesFromWindow,
  MAX_CANDIDATES,
  type WindowTurn,
} from "../src/core/context/entity-salience.ts";

describe("extractCandidates", () => {
  it("extracts a multi-token capitalized run", () => {
    const out = extractCandidates("I met Dana Reed yesterday at the office.");
    expect(out.map((c) => c.query)).toContain("Dana Reed");
  });

  it("strips a trailing possessive", () => {
    const out = extractCandidates("That is Dana's car.");
    expect(out.map((c) => c.query)).toContain("Dana");
    expect(out.map((c) => c.query)).not.toContain("Dana's");
  });

  it("captures @handles without the @ in the query", () => {
    const out = extractCandidates("ping @dana about it");
    const c = out.find((x) => x.query === "dana");
    expect(c).toBeDefined();
    expect(c?.display).toBe("@dana");
  });

  it("drops hard stopwords even when capitalized at sentence start", () => {
    const out = extractCandidates("They went home. The dog slept.");
    expect(out.map((c) => c.query.toLowerCase())).not.toContain("they");
    expect(out.map((c) => c.query.toLowerCase())).not.toContain("the");
  });

  it("drops a soft common word seen only at sentence start", () => {
    const out = extractCandidates("Monday is busy.");
    expect(out.map((c) => c.query.toLowerCase())).not.toContain("monday");
  });

  it("keeps a soft common word seen capitalized mid-sentence", () => {
    const out = extractCandidates("I love Apple products from Apple.");
    expect(out.map((c) => c.query)).toContain("Apple");
  });

  it("drops pure numbers and single chars", () => {
    const out = extractCandidates("In 2026 X happened.");
    expect(out.map((c) => c.query)).not.toContain("2026");
    expect(out.map((c) => c.query)).not.toContain("X");
  });

  it("dedupes on the normalized form (Dana vs dana)", () => {
    const out = extractCandidates("Dana called. Then dana left.");
    expect(out.filter((c) => c.query.toLowerCase() === "dana").length).toBe(1);
  });

  it("caps at MAX_CANDIDATES", () => {
    const many = Array.from({ length: 30 }, (_, i) => `Name${i} Surname${i}`).join(", ");
    expect(extractCandidates(many).length).toBeLessThanOrEqual(MAX_CANDIDATES);
  });

  it("returns [] for empty / non-string input", () => {
    expect(extractCandidates("")).toEqual([]);
    // @ts-expect-error deliberately wrong type
    expect(extractCandidates(null)).toEqual([]);
  });
});

describe("extractCandidatesFromWindow", () => {
  const turns = (...t: Array<[WindowTurn["role"], string]>): WindowTurn[] =>
    t.map(([role, text]) => ({ role, text }));

  it("merges occurrences across turns", () => {
    const out = extractCandidatesFromWindow(
      turns(["user", "Tell me about Dana Reed"], ["assistant", "Dana Reed founded a startup"]),
    );
    const c = out.find((x) => x.query === "Dana Reed");
    expect(c?.occurrences).toBe(2);
  });

  it("marks the newest-turn flag on a last-turn mention", () => {
    const out = extractCandidatesFromWindow(
      turns(["user", "hello there"], ["user", "what about Alice Smith"]),
    );
    const c = out.find((x) => x.query === "Alice Smith");
    expect(c?.inNewestTurn).toBe(true);
  });

  it("a user mention overrides an assistant-introduced display label", () => {
    const out = extractCandidatesFromWindow(
      turns(["assistant", "You might mean Bob"], ["user", "yes Bob"]),
    );
    const c = out.find((x) => x.query.toLowerCase() === "bob");
    expect(c?.userMention).toBe(true);
  });

  it("ranks a recent, repeated, user-said entity above stale assistant chatter", () => {
    const out = extractCandidatesFromWindow(
      turns(
        ["assistant", "Consider Zeta Corp and Stale Name"],
        ["user", "I care about Acme Inc"],
        ["user", "more on Acme Inc please"],
      ),
    );
    expect(out[0]?.query).toBe("Acme Inc");
  });

  it("returns [] for an empty window", () => {
    expect(extractCandidatesFromWindow([])).toEqual([]);
  });
});
