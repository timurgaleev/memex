import { describe, it, expect } from "bun:test";
import {
  extractWikilinks,
  extractHashtags,
  extractFrontmatterTags,
  extractDates,
  extractEntities,
  entityId,
} from "../src/core/entities.ts";

describe("extractWikilinks", () => {
  it("extracts plain wikilinks", () => {
    const r = extractWikilinks("see [[Project Alpha]] for details");
    expect(r).toHaveLength(1);
    expect(r[0]?.name).toBe("Project Alpha");
    expect(r[0]?.surfaceForm).toBe("[[Project Alpha]]");
  });

  it("extracts the target from aliased wikilinks", () => {
    const r = extractWikilinks("an [[Project Alpha|alpha]] rollout");
    expect(r[0]?.name).toBe("Project Alpha");
  });

  it("dedupes repeated wikilinks", () => {
    const r = extractWikilinks("[[Foo]] and [[Foo]] again");
    expect(r).toHaveLength(1);
  });
});

describe("extractHashtags", () => {
  it("extracts inline tags", () => {
    const r = extractHashtags("notes #project/work and #idea here");
    expect(r.map((e) => e.name).sort()).toEqual(["idea", "project/work"]);
  });

  it("does not pick up #fragment-style URL anchors", () => {
    const r = extractHashtags("see https://x.com/path#anchor for context");
    // 'anchor' is not preceded by whitespace so won't match.
    expect(r).toHaveLength(0);
  });
});

describe("extractFrontmatterTags", () => {
  it("reads array tags from frontmatter", () => {
    const r = extractFrontmatterTags({ tags: ["alpha", "Beta"] });
    expect(r.map((e) => e.name).sort()).toEqual(["alpha", "beta"]);
  });

  it("reads comma-separated string tags", () => {
    const r = extractFrontmatterTags({ tags: "alpha, beta , gamma" });
    expect(r.map((e) => e.name).sort()).toEqual(["alpha", "beta", "gamma"]);
  });

  it("returns empty when tags field is missing", () => {
    expect(extractFrontmatterTags({})).toEqual([]);
  });
});

describe("extractDates", () => {
  it("matches ISO YYYY-MM-DD", () => {
    const r = extractDates("event on 2026-05-05 and 2027-12-31");
    expect(r.map((e) => e.name).sort()).toEqual(["2026-05-05", "2027-12-31"]);
  });

  it("rejects implausible months/days", () => {
    const r = extractDates("bogus 2026-13-01 or 2026-01-32");
    expect(r).toEqual([]);
  });

  it("rejects pre-1900 / post-2099 years", () => {
    const r = extractDates("1899-01-01 and 2100-01-01");
    expect(r).toEqual([]);
  });
});

describe("extractEntities (combined)", () => {
  it("collects wikilinks + tags + dates and dedupes across types", () => {
    const md = "[[Foo]] tagged #foo on 2026-05-05 — see [[Foo]]";
    const r = extractEntities(md, { tags: ["foo"] });
    const types = new Set(r.map((e) => `${e.type}:${e.name}`));
    expect(types).toEqual(
      new Set(["wikilink:Foo", "tag:foo", "date:2026-05-05"]),
    );
  });
});

describe("entityId", () => {
  it("produces a stable, type-prefixed slug", () => {
    expect(entityId("wikilink", "Project Alpha")).toBe(
      "ent_wikilink_project-alpha",
    );
    expect(entityId("tag", "foo")).toBe("ent_tag_foo");
    expect(entityId("date", "2026-05-05")).toBe("ent_date_2026-05-05");
  });

  it("collapses non-alphanum runs", () => {
    expect(entityId("wikilink", "  weird  /  name  !  ")).toBe(
      "ent_wikilink_weird-name",
    );
  });
});
