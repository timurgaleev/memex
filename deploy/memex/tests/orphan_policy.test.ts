/**
 * Orphan exclusions.
 *
 * A brain writes plenty of pages that are islanded on purpose — synthesis
 * output, drift reports, session records. Counting them is what turned the
 * orphan number into noise nobody reads. The policy lives in one module so the
 * count and the listing cannot disagree; a count from one definition and a
 * listing from another is how a finding ends up describing something the
 * operator cannot reproduce.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { putPage } from "../src/core/pages.ts";
import { findOrphans } from "../src/core/insights.ts";
import {
  DEFAULT_ORPHAN_EXCLUDED_PREFIXES,
  orphanExcludedPrefixes,
  orphanExclusionPatterns,
  isExcludedFromOrphans,
} from "../src/core/orphan-policy.ts";

describe("orphanExcludedPrefixes", () => {
  it("defaults to the generated-page prefixes", () => {
    expect(orphanExcludedPrefixes({})).toEqual([...DEFAULT_ORPHAN_EXCLUDED_PREFIXES]);
  });

  it("EXTRA adds, PREFIXES replaces", () => {
    expect(orphanExcludedPrefixes({ MEMEX_ORPHAN_EXCLUDE_EXTRA: "inbox/,daily/" })).toEqual([
      ...DEFAULT_ORPHAN_EXCLUDED_PREFIXES,
      "inbox/",
      "daily/",
    ]);
    expect(
      orphanExcludedPrefixes({ MEMEX_ORPHAN_EXCLUDE_PREFIXES: "only/" }),
    ).toEqual(["only/"]);
  });

  it("lets a brain turn exclusions off entirely", () => {
    // A set-but-empty override is a decision, not an accident. Presence is what
    // counts: the plain `MEMEX_ORPHAN_EXCLUDE_PREFIXES=` form has to work, not
    // just a whitespace string that happens to survive a length check.
    expect(orphanExcludedPrefixes({ MEMEX_ORPHAN_EXCLUDE_PREFIXES: "" })).toEqual([]);
    expect(orphanExcludedPrefixes({ MEMEX_ORPHAN_EXCLUDE_PREFIXES: " " })).toEqual([]);
    // Unset is different from set-empty — it keeps the defaults.
    expect(orphanExcludedPrefixes({})).toEqual([...DEFAULT_ORPHAN_EXCLUDED_PREFIXES]);
  });

  it("escapes LIKE metacharacters in a prefix", () => {
    // An underscore in a slug prefix is a literal, not "any character".
    expect(orphanExclusionPatterns({ MEMEX_ORPHAN_EXCLUDE_PREFIXES: "a_b/" })).toEqual([
      "a\\_b/%",
    ]);
  });

  it("agrees with the predicate", () => {
    expect(isExcludedFromOrphans("reflections/2026-01", {})).toBe(true);
    expect(isExcludedFromOrphans("people/alice", {})).toBe(false);
  });
});

describe("findOrphans", () => {
  let tmp: string;
  let storage: Storage;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "memex-orphanpolicy-"));
    storage = new Storage({ dbPath: join(tmp, "db") });
    await storage.init();
  });

  afterEach(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("omits pages that are islanded by design", async () => {
    await putPage(storage, { slug: "people/alice", type: "person" });
    await putPage(storage, { slug: "reflections/2026-01-01", type: "note" });
    await putPage(storage, { slug: "drift-reports/2026-01-01", type: "note" });

    const slugs = (await findOrphans(storage)).map((r) => r.slug);
    expect(slugs).toEqual(["people/alice"]);
  });
});
