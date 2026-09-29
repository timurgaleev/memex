/**
 * Title-phrase matching + boost-factor resolution (title-match.ts).
 */
import { describe, expect, it } from "bun:test";
import {
  isTitlePhraseMatch,
  resolveTitleBoost,
  TitleBoostParseError,
  DEFAULT_TITLE_BOOST,
  __test__,
} from "../src/core/search/title-match.ts";

const { tokenizeTitle, containsTokenRun } = __test__;

describe("isTitlePhraseMatch", () => {
  it("matches a contiguous phrase inside the title", () => {
    expect(isTitlePhraseMatch("master plan", "Memex — master plan for the brain")).toBe(true);
  });

  it("matches an exact full-title (covers single-word chosen names)", () => {
    expect(isTitlePhraseMatch("Mingtang", "Mingtang")).toBe(true);
  });

  it("rejects a single content token that is not a full-title match", () => {
    // "plan" alone is < MIN_CONTENT_TOKENS and not the whole title.
    expect(isTitlePhraseMatch("plan", "Memex master plan")).toBe(false);
  });

  it("does NOT match across token boundaries (substring guard)", () => {
    // "art" must not match "Bartholomew".
    expect(isTitlePhraseMatch("art", "Bartholomew")).toBe(false);
  });

  it("does NOT match a non-contiguous bag of words", () => {
    expect(isTitlePhraseMatch("memex brain", "Memex — master plan for the brain")).toBe(false);
  });

  it("ignores stopwords toward the content-token floor", () => {
    // "the plan" → 1 content token ("plan") → below floor, not a full title.
    expect(isTitlePhraseMatch("the plan", "Memex master plan")).toBe(false);
  });

  it("is punctuation/case insensitive (NFKC + lowercase + non-alnum split)", () => {
    expect(isTitlePhraseMatch("master-plan", "MASTER PLAN doc")).toBe(true);
  });

  it("returns false for empty / null title or empty query", () => {
    expect(isTitlePhraseMatch("anything", null)).toBe(false);
    expect(isTitlePhraseMatch("anything", "")).toBe(false);
    expect(isTitlePhraseMatch("", "Some title")).toBe(false);
  });
});

describe("tokenizeTitle", () => {
  it("lowercases and splits on non-alphanumeric runs", () => {
    expect(tokenizeTitle("Memex — Master Plan!")).toEqual(["memex", "master", "plan"]);
  });
  it("drops empties and returns [] for falsy input", () => {
    expect(tokenizeTitle("")).toEqual([]);
  });
});

describe("containsTokenRun", () => {
  it("finds a contiguous needle run", () => {
    expect(containsTokenRun(["a", "b", "c", "d"], ["b", "c"])).toBe(true);
  });
  it("rejects a non-contiguous or longer needle", () => {
    expect(containsTokenRun(["a", "b", "c"], ["a", "c"])).toBe(false);
    expect(containsTokenRun(["a"], ["a", "b"])).toBe(false);
  });
});

describe("resolveTitleBoost", () => {
  it("defaults to DEFAULT_TITLE_BOOST when unset / empty", () => {
    expect(resolveTitleBoost(undefined)).toBe(DEFAULT_TITLE_BOOST);
    expect(resolveTitleBoost("")).toBe(DEFAULT_TITLE_BOOST);
    expect(resolveTitleBoost("   ")).toBe(DEFAULT_TITLE_BOOST);
  });
  it("parses a valid numeric factor", () => {
    expect(resolveTitleBoost("1.5")).toBe(1.5);
    expect(resolveTitleBoost("1")).toBe(1);
    expect(resolveTitleBoost("0")).toBe(0); // disables (multiplier inert path keys off > 1.0)
  });
  it("throws on malformed input (fail-loud)", () => {
    expect(() => resolveTitleBoost("1.2x")).toThrow(TitleBoostParseError);
    expect(() => resolveTitleBoost("abc")).toThrow(TitleBoostParseError);
    expect(() => resolveTitleBoost("-1")).toThrow(TitleBoostParseError);
  });
});
