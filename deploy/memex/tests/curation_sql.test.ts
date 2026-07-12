/**
 * Curation tier map + arm-SQL builders (G21) — pure, no DB.
 * The SQL fragments themselves are exercised end-to-end by the retrieval
 * suites (every keyword/vector call now interpolates them).
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
  DEFAULT_CURATION_BOOST,
  DEFAULT_SEARCH_EXCLUDE,
  buildCurationBoostCaseSql,
  buildHardExcludeClauseSql,
  normalizedPathSql,
  getSearchExcludePrefixes,
  _resetCurationForTests,
} from "../src/core/search/curation.ts";

const savedExclude = process.env.MEMEX_SEARCH_EXCLUDE;
afterEach(() => {
  if (savedExclude === undefined) delete process.env.MEMEX_SEARCH_EXCLUDE;
  else process.env.MEMEX_SEARCH_EXCLUDE = savedExclude;
  _resetCurationForTests();
});

describe("full tier map", () => {
  it("carries the full tier order: curated > entities > meetings > bulk > extracts", () => {
    expect(DEFAULT_CURATION_BOOST["originals/"]).toBe(1.5);
    expect(DEFAULT_CURATION_BOOST["writing/"]).toBe(1.4);
    expect(DEFAULT_CURATION_BOOST["concepts/"]).toBe(1.3);
    expect(DEFAULT_CURATION_BOOST["people/"]).toBe(1.2);
    expect(DEFAULT_CURATION_BOOST["companies/"]).toBe(1.2);
    expect(DEFAULT_CURATION_BOOST["deals/"]).toBe(1.2);
    expect(DEFAULT_CURATION_BOOST["meetings/"]).toBe(1.1);
    expect(DEFAULT_CURATION_BOOST["media/articles/"]).toBe(1.1);
    expect(DEFAULT_CURATION_BOOST["media/repos/"]).toBe(1.1);
    expect(DEFAULT_CURATION_BOOST["daily/"]).toBe(0.8);
    expect(DEFAULT_CURATION_BOOST["media/x/"]).toBe(0.7);
    expect(DEFAULT_CURATION_BOOST["chat/"]).toBe(0.5);
    expect(DEFAULT_CURATION_BOOST["archive/"]).toBe(0.5);
    expect(DEFAULT_CURATION_BOOST["extracts/"]).toBe(0.3);
    expect(Object.keys(DEFAULT_CURATION_BOOST).length).toBe(14);
  });

  it("ships the default hard-excludes", () => {
    expect([...DEFAULT_SEARCH_EXCLUDE]).toEqual(["test/", "attachments/", ".raw/"]);
    _resetCurationForTests();
    delete process.env.MEMEX_SEARCH_EXCLUDE;
    expect([...getSearchExcludePrefixes()]).toEqual(["test/", "attachments/", ".raw/"]);
  });
});

describe("buildCurationBoostCaseSql", () => {
  it("emits longest-prefix-first WHENs over the normalized path", () => {
    const sql = buildCurationBoostCaseSql("d.source_path", {
      "media/": 0.9,
      "media/articles/": 1.1,
    });
    const articles = sql.indexOf("media/articles/");
    const media = sql.indexOf("'media/%'");
    expect(articles).toBeGreaterThan(-1);
    expect(media).toBeGreaterThan(-1);
    expect(articles).toBeLessThan(media); // longest first
    expect(sql).toContain("ELSE 1.0 END");
  });

  it("normalizes page:// and page-truth:// schemes before matching", () => {
    const expr = normalizedPathSql("d.source_path");
    expect(expr).toContain("substr(d.source_path, 8)"); // 'page://'
    expect(expr).toContain("substr(d.source_path, 14)"); // 'page-truth://'
  });

  it("escapes LIKE metacharacters and quotes in prefixes", () => {
    const sql = buildCurationBoostCaseSql("p", { "we%ird_'/": 1.2 });
    expect(sql).toContain("we\\%ird\\_''/");
  });

  it("collapses to '1.0' with no valid entries", () => {
    expect(buildCurationBoostCaseSql("p", {})).toBe("1.0");
    expect(buildCurationBoostCaseSql("p", { "x/": Number.NaN })).toBe("1.0");
  });
});

describe("buildHardExcludeClauseSql", () => {
  it("emits an AND NOT (…) chain for the default excludes", () => {
    _resetCurationForTests();
    delete process.env.MEMEX_SEARCH_EXCLUDE;
    const clause = buildHardExcludeClauseSql("d.source_path");
    expect(clause).toContain("AND NOT (");
    expect(clause).toContain("'test/%'");
    expect(clause).toContain("'attachments/%'");
    expect(clause).toContain("'.raw/%'");
  });

  it("returns empty when the operator cleared the list", () => {
    expect(buildHardExcludeClauseSql("d.source_path", [])).toBe("");
  });
});
