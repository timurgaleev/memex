/**
 * Entity-slug canonicalization — the 4-stage wikilink resolver
 * (core/slug-canonicalize.ts) + its integration into syncWikilinksForPage.
 *
 * Stages: exact slug → trgm fuzzy (title + slug basename) → prefix-expansion
 * by connection_count → slugify fallback. Proven against PGLite with the
 * pg_trgm contrib extension loaded (migration 033).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { putPage } from "../src/core/pages.ts";
import {
  addLink,
  graphNeighbors,
  syncWikilinksForPage,
} from "../src/core/links.ts";
import {
  canonicalizeEnabled,
  makeSlugResolver,
  resolveTrgmThreshold,
} from "../src/core/slug-canonicalize.ts";

let tmp: string;
let storage: Storage;

// Canonicalization reads env at resolver-build time — keep each test
// hermetic by clearing the knobs around every case.
function clearEnv(): void {
  delete process.env.MEMEX_WIKILINK_CANONICALIZE;
  delete process.env.MEMEX_WIKILINK_TRGM;
}

beforeEach(async () => {
  clearEnv();
  tmp = mkdtempSync(join(tmpdir(), "memex-canon-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterEach(async () => {
  clearEnv();
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Env knobs
// ---------------------------------------------------------------------------

describe("canonicalization knobs", () => {
  it("is on by default, off only on an explicit 0", () => {
    expect(canonicalizeEnabled(undefined)).toBe(true);
    expect(canonicalizeEnabled("1")).toBe(true);
    expect(canonicalizeEnabled("")).toBe(true);
    expect(canonicalizeEnabled("0")).toBe(false);
  });

  it("defaults the trgm threshold and validates overrides", () => {
    expect(resolveTrgmThreshold(undefined)).toBe(0.7);
    expect(resolveTrgmThreshold("0.8")).toBe(0.8);
    expect(() => resolveTrgmThreshold("2")).toThrow(/MEMEX_WIKILINK_TRGM/);
    expect(() => resolveTrgmThreshold("nope")).toThrow(/MEMEX_WIKILINK_TRGM/);
    expect(() => resolveTrgmThreshold("-0.1")).toThrow(/MEMEX_WIKILINK_TRGM/);
  });
});

// ---------------------------------------------------------------------------
// makeSlugResolver — stage cascade
// ---------------------------------------------------------------------------

describe("makeSlugResolver", () => {
  it("stage 1 — exact slug match", async () => {
    await putPage(storage, { slug: "people/alice", type: "person" });
    const r = await makeSlugResolver(storage, "journal/x").resolve("people/alice");
    expect(r).toEqual({ slug: "people/alice", resolved: true, stage: "exact" });
  });

  it("stage 2 — declared alias resolves authoritatively", async () => {
    await putPage(storage, {
      slug: "people/bob",
      type: "person",
      title: "Bob Jones",
      compiled_truth: { aliases: ["Robert", "Bobby"] },
    });
    const r = await makeSlugResolver(storage, "journal/x").resolve("Robert");
    expect(r.slug).toBe("people/bob");
    expect(r.resolved).toBe(true);
    expect(r.stage).toBe("alias");
  });

  it("stage 2 — an alias collision falls through (not arbitrated)", async () => {
    await putPage(storage, {
      slug: "teams/red/standup",
      type: "note",
      compiled_truth: { aliases: ["Standup"] },
    });
    await putPage(storage, {
      slug: "teams/blue/standup",
      type: "note",
      compiled_truth: { aliases: ["Standup"] },
    });
    const r = await makeSlugResolver(storage, "journal/x").resolve("Standup");
    expect(r.resolved).toBe(false);
    expect(r.stage).toBe("slugify");
  });

  it("stage 3 — unique exact-tail match (slugified name == basename)", async () => {
    await putPage(storage, {
      slug: "people/alice-smith",
      type: "person",
      title: "Alice Smith",
    });
    const r = await makeSlugResolver(storage, "journal/x").resolve("Alice Smith");
    expect(r.slug).toBe("people/alice-smith");
    expect(r.resolved).toBe(true);
    expect(r.stage).toBe("exact_tail");
  });

  it("stage 2 — ambiguous exact-tail (two namespaces) falls to slugify", async () => {
    await putPage(storage, { slug: "people/acme", type: "person" });
    await putPage(storage, { slug: "companies/acme", type: "company" });
    const r = await makeSlugResolver(storage, "journal/x").resolve("Acme");
    // Two pages share the `acme` basename — real ambiguity, not arbitrated.
    expect(r.resolved).toBe(false);
    expect(r.stage).toBe("slugify");
    expect(r.slug).toBe("acme");
  });

  it("stage 4 — trgm tolerates a small typo (sole candidate)", async () => {
    await putPage(storage, {
      slug: "people/alice-smith",
      type: "person",
      title: "Alice Smith",
    });
    // Near-miss spelling; sole candidate so the margin gate is satisfied.
    const r = await makeSlugResolver(storage, "journal/x").resolve("Alice Smithh");
    expect(r.slug).toBe("people/alice-smith");
    expect(r.resolved).toBe(true);
    expect(r.stage).toBe("trgm");
  });

  it("stage 3 — prefix-expansion to a longer basename", async () => {
    await putPage(storage, {
      slug: "people/alice-smith",
      type: "person",
      title: "Alice Smith",
    });
    // Bare first name: below the trgm floor, caught by prefix expansion.
    const r = await makeSlugResolver(storage, "journal/x").resolve("alice");
    expect(r.slug).toBe("people/alice-smith");
    expect(r.resolved).toBe(true);
    expect(r.stage).toBe("prefix");
  });

  it("stage 3 — ambiguous prefix (two expansions) falls to slugify", async () => {
    await putPage(storage, { slug: "people/sam-anderson", type: "person" });
    await putPage(storage, { slug: "people/sam-baker", type: "person" });
    // Two pages expand `sam` — not arbitrated (no connection_count bias),
    // a dangling `sam` is safer than a confident wrong edge.
    const r = await makeSlugResolver(storage, "journal/x").resolve("sam");
    expect(r.resolved).toBe(false);
    expect(r.stage).toBe("slugify");
    expect(r.slug).toBe("sam");
  });

  it("stage 4 — a near-tie fuzzy match is rejected by the margin gate", async () => {
    // Two pages with the SAME title in different namespaces: the query
    // scores 1.0 against BOTH, so the margin gate (top − second) refuses
    // to arbitrate and falls through to slugify.
    await putPage(storage, {
      slug: "teams/red/standup",
      type: "note",
      title: "Standup Notes",
    });
    await putPage(storage, {
      slug: "teams/blue/standup",
      type: "note",
      title: "Standup Notes",
    });
    const r = await makeSlugResolver(storage, "journal/x").resolve("Standup Notes");
    expect(r.resolved).toBe(false);
    expect(r.stage).toBe("slugify");
  });

  it("stage 4 — slugify fallback when nothing matches", async () => {
    await putPage(storage, { slug: "people/alice", type: "person" });
    const r = await makeSlugResolver(storage, "journal/x").resolve("Totally Unrelated");
    expect(r).toEqual({
      slug: "totally-unrelated",
      resolved: false,
      stage: "slugify",
    });
  });

  it("never canonicalizes a mention onto its own source page", async () => {
    await putPage(storage, {
      slug: "people/alice-smith",
      type: "person",
      title: "Alice Smith",
    });
    // Source IS the only candidate → fuzzy/prefix exclude self → fallback.
    const r = await makeSlugResolver(storage, "people/alice-smith").resolve("Alice S");
    expect(r.resolved).toBe(false);
    expect(r.stage).toBe("slugify");
  });

  it("never reports a qualified self-resolution (stage-1 self-skip)", async () => {
    await putPage(storage, { slug: "people/alice", type: "person" });
    // Resolving the source's own slug must NOT come back resolved:true.
    const r = await makeSlugResolver(storage, "people/alice").resolve("people/alice");
    expect(r.resolved).toBe(false);
    expect(r.stage).toBe("slugify");
    expect(r.slug).toBe("people/alice");
  });

  it("does not prefix-expand onto an unnamespaced top-level page", async () => {
    await putPage(storage, { slug: "project-alpha", type: "note" });
    // `[[proj]]` must not sprawl onto a bare top-level slug.
    const r = await makeSlugResolver(storage, "journal/x").resolve("proj");
    expect(r.resolved).toBe(false);
    expect(r.stage).toBe("slugify");
    expect(r.slug).toBe("proj");
  });

  it("kill switch falls straight through to slugify", async () => {
    process.env.MEMEX_WIKILINK_CANONICALIZE = "0";
    await putPage(storage, {
      slug: "people/alice-smith",
      type: "person",
      title: "Alice Smith",
    });
    const r = await makeSlugResolver(storage, "journal/x").resolve("Alice Smith");
    expect(r).toEqual({
      slug: "alice-smith",
      resolved: false,
      stage: "slugify",
    });
  });

  it("a high threshold suppresses a borderline fuzzy match", async () => {
    process.env.MEMEX_WIKILINK_TRGM = "0.99";
    await putPage(storage, {
      slug: "people/alice-smith",
      type: "person",
      title: "Alice Smith",
    });
    // Typo no longer clears the raised floor; prefix can't help (not a
    // prefix of the basename) → slugify.
    const r = await makeSlugResolver(storage, "journal/x").resolve("Alice Smiht");
    expect(r.resolved).toBe(false);
    expect(r.stage).toBe("slugify");
  });

  it("caches repeated mentions (same result object)", async () => {
    await putPage(storage, { slug: "people/alice", type: "person" });
    const resolver = makeSlugResolver(storage, "journal/x");
    const a = await resolver.resolve("people/alice");
    const b = await resolver.resolve("people/alice");
    expect(a).toBe(b); // identity — served from cache
  });
});

// ---------------------------------------------------------------------------
// syncWikilinksForPage — canonicalized edges + resolution_type
// ---------------------------------------------------------------------------

interface ProvRow {
  target_slug: string;
  link_kind: string | null;
  resolution_type: string | null;
}

async function wikilinkRows(src: string): Promise<ProvRow[]> {
  const r = await storage.engine().query<ProvRow>(
    `SELECT target_slug, link_kind, resolution_type
       FROM links WHERE source_slug = $1 AND type = 'wikilink'
      ORDER BY target_slug`,
    [src],
  );
  return r.rows;
}

describe("syncWikilinksForPage canonicalization", () => {
  it("rewrites a loose mention onto the canonical page slug", async () => {
    await putPage(storage, {
      slug: "people/alice-smith",
      type: "person",
      title: "Alice Smith",
    });
    await putPage(storage, { slug: "journal/today", type: "journal" });
    const r = await syncWikilinksForPage(
      storage,
      "journal/today",
      "had lunch with [[Alice Smith]]",
    );
    expect(r.added).toBe(1);
    const links = await graphNeighbors(storage, "journal/today", {
      type: "wikilink",
      direction: "outbound",
    });
    expect(links.map((l) => l.target_slug)).toEqual(["people/alice-smith"]);
  });

  it("stamps qualified vs unqualified resolution_type", async () => {
    await putPage(storage, {
      slug: "people/alice-smith",
      type: "person",
      title: "Alice Smith",
    });
    await putPage(storage, { slug: "journal/today", type: "journal" });
    await syncWikilinksForPage(
      storage,
      "journal/today",
      "[[Alice Smith]] and [[Nobody Here]]",
    );
    const rows = await wikilinkRows("journal/today");
    const byTarget = new Map(rows.map((r) => [r.target_slug, r]));
    expect(byTarget.get("people/alice-smith")?.resolution_type).toBe("qualified");
    expect(byTarget.get("people/alice-smith")?.link_kind).toBe("plain");
    expect(byTarget.get("nobody-here")?.resolution_type).toBe("unqualified");
    expect(byTarget.get("nobody-here")?.link_kind).toBe("plain");
  });

  it("collapses two surface forms that resolve to the same page", async () => {
    await putPage(storage, {
      slug: "people/alice-smith",
      type: "person",
      title: "Alice Smith",
    });
    await putPage(storage, { slug: "journal/today", type: "journal" });
    const r = await syncWikilinksForPage(
      storage,
      "journal/today",
      "[[Alice Smith]] then later [[alice]]",
    );
    // Both forms → people/alice-smith → a single edge.
    expect(r.added).toBe(1);
    const links = await graphNeighbors(storage, "journal/today", {
      type: "wikilink",
      direction: "outbound",
    });
    expect(links.map((l) => l.target_slug)).toEqual(["people/alice-smith"]);
  });

  it("preserves legacy targets when no page matches", async () => {
    await putPage(storage, { slug: "journal/today", type: "journal" });
    await syncWikilinksForPage(storage, "journal/today", "[[Bob]] [[Carol]]");
    const links = await graphNeighbors(storage, "journal/today", {
      type: "wikilink",
      direction: "outbound",
    });
    expect(links.map((l) => l.target_slug).sort()).toEqual(["bob", "carol"]);
  });
});
