/**
 * Typed-link inference — frontmatter schema-pack deriving works_at / founded /
 * attended edges (link_kind='typed_ner'), opt-in MEMEX_TYPED_LINKS=1.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { putPage } from "../src/core/pages.ts";
import { addLink } from "../src/core/links.ts";
import { syncTypedLinksForPage, typedLinksEnabled } from "../src/core/typed-links.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  process.env.MEMEX_TYPED_LINKS = "1";
  tmp = mkdtempSync(join(tmpdir(), "memex-typedlinks-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});
afterEach(async () => {
  delete process.env.MEMEX_TYPED_LINKS;
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

interface LinkRow {
  source_slug: string;
  target_slug: string;
  type: string;
  link_kind: string | null;
  origin_slug: string | null;
}

async function linksFor(origin: string): Promise<LinkRow[]> {
  const r = await storage.engine().query<LinkRow>(
    `SELECT source_slug, target_slug, type, link_kind, origin_slug
       FROM links WHERE origin_slug = $1 ORDER BY source_slug, target_slug, type`,
    [origin],
  );
  return r.rows;
}

async function sync(slug: string): Promise<{ added: number; removed: number }> {
  const p = await storage.engine().query<{ type: string; compiled_truth: Record<string, unknown> }>(
    `SELECT type, compiled_truth FROM pages WHERE slug = $1`,
    [slug],
  );
  return syncTypedLinksForPage(storage, slug, p.rows[0]!.type, p.rows[0]!.compiled_truth);
}

describe("typedLinksEnabled", () => {
  it("is ON only for exactly '1'", () => {
    expect(typedLinksEnabled("1")).toBe(true);
    expect(typedLinksEnabled("0")).toBe(false);
    expect(typedLinksEnabled("")).toBe(false);
    expect(typedLinksEnabled("true")).toBe(false);
  });
});

describe("syncTypedLinksForPage", () => {
  it("is a no-op when disabled", async () => {
    delete process.env.MEMEX_TYPED_LINKS;
    await putPage(storage, { slug: "companies/acme", type: "company" });
    await putPage(storage, {
      slug: "people/alice",
      type: "person",
      compiled_truth: { company: ["Acme"] },
    });
    const res = await sync("people/alice");
    expect(res).toEqual({ added: 0, removed: 0 });
  });

  it("derives an OUTGOING works_at edge (person.company → company)", async () => {
    await putPage(storage, { slug: "companies/acme", type: "company", title: "Acme" });
    await putPage(storage, {
      slug: "people/alice",
      type: "person",
      compiled_truth: { company: ["Acme"] },
    });
    const res = await sync("people/alice");
    expect(res.added).toBe(1);
    const links = await linksFor("people/alice");
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      source_slug: "people/alice",
      target_slug: "companies/acme",
      type: "works_at",
      link_kind: "typed_ner",
      origin_slug: "people/alice",
    });
  });

  it("derives an INCOMING attended edge (meeting.attendees → attendee→meeting)", async () => {
    await putPage(storage, { slug: "people/bob", type: "person", title: "Bob" });
    await putPage(storage, {
      slug: "meetings/standup",
      type: "meeting",
      compiled_truth: { attendees: ["Bob"] },
    });
    const res = await sync("meetings/standup");
    expect(res.added).toBe(1);
    const links = await linksFor("meetings/standup");
    expect(links[0]).toMatchObject({
      source_slug: "people/bob", // attendee is the SOURCE of an 'attended' edge
      target_slug: "meetings/standup",
      type: "attended",
      link_kind: "typed_ner",
    });
  });

  it("derives related_to from see_also on ANY page type (note)", async () => {
    await putPage(storage, { slug: "notes/topic-b", type: "note", title: "Topic B" });
    await putPage(storage, {
      slug: "notes/topic-a",
      type: "note",
      compiled_truth: { see_also: ["Topic B"] },
    });
    const res = await sync("notes/topic-a");
    expect(res.added).toBe(1);
    const links = await linksFor("notes/topic-a");
    expect(links[0]).toMatchObject({
      source_slug: "notes/topic-a",
      target_slug: "notes/topic-b",
      type: "related_to",
      link_kind: "typed_ner",
    });
  });

  it("skips values that do not resolve to a real page (resolved-only)", async () => {
    await putPage(storage, {
      slug: "people/carol",
      type: "person",
      compiled_truth: { company: ["NonexistentCorp"] },
    });
    const res = await sync("people/carol");
    expect(res.added).toBe(0);
    expect(await linksFor("people/carol")).toHaveLength(0);
  });

  it("is idempotent and reflects frontmatter edits on re-sync", async () => {
    await putPage(storage, { slug: "companies/acme", type: "company", title: "Acme" });
    await putPage(storage, { slug: "companies/globex", type: "company", title: "Globex" });
    await putPage(storage, {
      slug: "people/dave",
      type: "person",
      compiled_truth: { company: ["Acme"] },
    });
    await sync("people/dave");
    // edit frontmatter: now at Globex
    await putPage(storage, {
      slug: "people/dave",
      type: "person",
      compiled_truth: { company: ["Globex"] },
    });
    const res = await sync("people/dave");
    expect(res.removed).toBe(1); // old Acme edge wiped
    expect(res.added).toBe(1);
    const links = await linksFor("people/dave");
    expect(links).toHaveLength(1);
    expect(links[0]!.target_slug).toBe("companies/globex");
  });

  it("coexists with an explicit edge of the same (source, target, type)", async () => {
    await putPage(storage, { slug: "companies/acme", type: "company", title: "Acme" });
    await putPage(storage, {
      slug: "people/erin",
      type: "person",
      compiled_truth: { company: ["Acme"] },
    });
    // explicit operator-asserted edge first (link_kind NULL)
    await addLink(storage, {
      source_slug: "people/erin",
      target_slug: "companies/acme",
      type: "works_at",
    });
    const res = await sync("people/erin");
    // mig086: separate rows per writer — the frontmatter edge lands under its
    // own 'frontmatter' provenance; the explicit 'manual' edge is untouched.
    expect(res.added).toBe(1);
    const all = await storage.engine().query<{ link_kind: string | null; link_source: string }>(
      `SELECT link_kind, link_source FROM links
        WHERE source_slug = $1 AND target_slug = $2 AND type = 'works_at'
        ORDER BY link_source`,
      ["people/erin", "companies/acme"],
    );
    expect(all.rows).toHaveLength(2);
    expect(all.rows[0]).toEqual({ link_kind: "typed_ner", link_source: "frontmatter" });
    expect(all.rows[1]).toEqual({ link_kind: null, link_source: "manual" });
  });
});
