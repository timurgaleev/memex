/**
 * Retrieval-precision signals: canonical-query recency/salience gate +
 * slug-prefix curation boost / hard-exclude. Pure functions, no DB.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { isCanonicalQuery } from "../src/core/search/recency-gate.ts";
import {
  curationMultiplierForPath,
  isExcludedPath,
  getCurationBoostMap,
  getSearchExcludePrefixes,
  _resetCurationForTests,
  DEFAULT_CURATION_BOOST,
} from "../src/core/search/curation.ts";

describe("isCanonicalQuery", () => {
  it("flags definitional / who-is / define / symbol queries", () => {
    expect(isCanonicalQuery("who is Alice")).toBe(true);
    expect(isCanonicalQuery("what is a brain")).toBe(true);
    expect(isCanonicalQuery("define hybrid search")).toBe(true);
    expect(isCanonicalQuery("explain how RRF works")).toBe(true);
    expect(isCanonicalQuery("Storage::query")).toBe(true);
    expect(isCanonicalQuery("function hybridSearch")).toBe(true);
  });
  it("does NOT flag when an explicit temporal bound is present", () => {
    expect(isCanonicalQuery("who is Alice today")).toBe(false);
    expect(isCanonicalQuery("what is the latest status")).toBe(false);
    expect(isCanonicalQuery("what happened this week")).toBe(false);
    expect(isCanonicalQuery("define Y last week")).toBe(false);
    expect(isCanonicalQuery("explain Z last month")).toBe(false);
  });
  it("does NOT flag freshness-seeking or empty queries", () => {
    expect(isCanonicalQuery("recent deploys")).toBe(false);
    expect(isCanonicalQuery("standup notes")).toBe(false);
    expect(isCanonicalQuery("")).toBe(false);
  });
});

describe("curationMultiplierForPath", () => {
  it("applies the default authority weights by prefix (reference tier map)", () => {
    expect(curationMultiplierForPath("originals/note", DEFAULT_CURATION_BOOST)).toBe(1.5);
    expect(curationMultiplierForPath("chat/log", DEFAULT_CURATION_BOOST)).toBe(0.5);
    expect(curationMultiplierForPath("archive/old", DEFAULT_CURATION_BOOST)).toBe(0.5);
    expect(curationMultiplierForPath("people/alice", DEFAULT_CURATION_BOOST)).toBe(1.2);
    expect(curationMultiplierForPath("extracts/receipt", DEFAULT_CURATION_BOOST)).toBe(0.3);
  });
  it("is neutral (1.0) off-prefix or for null", () => {
    expect(curationMultiplierForPath("src/foo.ts", DEFAULT_CURATION_BOOST)).toBe(1.0);
    expect(curationMultiplierForPath(null, DEFAULT_CURATION_BOOST)).toBe(1.0);
  });
  it("longest prefix wins", () => {
    const map = { "a/": 0.5, "a/b/": 1.5 };
    expect(curationMultiplierForPath("a/b/c", map)).toBe(1.5);
    expect(curationMultiplierForPath("a/x", map)).toBe(0.5);
  });
});

describe("isExcludedPath", () => {
  it("matches any configured prefix; empty config excludes nothing", () => {
    expect(isExcludedPath("tests/fix.ts", ["tests/"])).toBe(true);
    expect(isExcludedPath("src/a.ts", ["tests/"])).toBe(false);
    expect(isExcludedPath("anything", [])).toBe(false);
    expect(isExcludedPath(null, ["tests/"])).toBe(false);
  });
});

describe("env resolution", () => {
  afterEach(() => {
    delete process.env["MEMEX_CURATION_BOOST"];
    delete process.env["MEMEX_SEARCH_EXCLUDE"];
    _resetCurationForTests();
  });

  it("env overrides the default curation map and fails loud on bad input", () => {
    process.env["MEMEX_CURATION_BOOST"] = "vip/:2.0";
    _resetCurationForTests();
    expect(getCurationBoostMap()).toEqual({ "vip/": 2.0 });

    process.env["MEMEX_CURATION_BOOST"] = "vip/:notanumber";
    _resetCurationForTests();
    expect(() => getCurationBoostMap()).toThrow(/positive number/);

    process.env["MEMEX_CURATION_BOOST"] = "vip/:0";
    _resetCurationForTests();
    expect(() => getCurationBoostMap()).toThrow(/positive number/);
  });

  it("parses the exclude prefix list from env", () => {
    process.env["MEMEX_SEARCH_EXCLUDE"] = "tests/, attachments/ ,.raw/";
    _resetCurationForTests();
    expect(getSearchExcludePrefixes()).toEqual(["tests/", "attachments/", ".raw/"]);
  });
});
