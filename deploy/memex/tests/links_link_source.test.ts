/**
 * links.link_source provenance (migration 086): writer stamping, the widened
 * unique key (same triple from different writers = separate rows), and the
 * backlink-boost mentions exclusion by provenance.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { putPage } from "../src/core/pages.ts";
import { addLink, syncWikilinksForPage } from "../src/core/links.ts";
import { defaultBacklinkCounts } from "../src/core/search/backlink-boost.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-linksrc-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  await putPage(storage, { slug: "people/alice", type: "person" });
  await putPage(storage, { slug: "companies/acme", type: "company" });
});
afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function linkRows(): Promise<
  { source_slug: string; target_slug: string; type: string; link_source: string }[]
> {
  const r = await storage
    .engine()
    .query<{ source_slug: string; target_slug: string; type: string; link_source: string }>(
      `SELECT source_slug, target_slug, type, link_source
         FROM links ORDER BY source_slug, target_slug, type, link_source`,
    );
  return r.rows;
}

describe("link_source stamping", () => {
  it("addLink stamps 'manual'; wikilink sync stamps 'markdown'", async () => {
    await addLink(storage, {
      source_slug: "people/alice",
      target_slug: "companies/acme",
      type: "works_at",
    });
    await syncWikilinksForPage(storage, "people/alice", "See [[companies/acme]].");
    const rows = await linkRows();
    expect(rows).toEqual([
      {
        source_slug: "people/alice",
        target_slug: "companies/acme",
        type: "wikilink",
        link_source: "markdown",
      },
      {
        source_slug: "people/alice",
        target_slug: "companies/acme",
        type: "works_at",
        link_source: "manual",
      },
    ]);
  });

  it("same triple from different writers keeps separate rows (widened key)", async () => {
    await addLink(storage, {
      source_slug: "people/alice",
      target_slug: "companies/acme",
      type: "works_at",
    });
    // A frontmatter-derived edge on the SAME triple — pre-076 this collided
    // with (and was swallowed by) the manual row.
    await storage.engine().query(
      `INSERT INTO links (source_slug, target_slug, type, inferred_confidence,
                          link_kind, link_source)
       VALUES ('people/alice', 'companies/acme', 'works_at', 0.9, 'typed_ner', 'frontmatter')`,
    );
    const rows = await linkRows();
    expect(rows.filter((r) => r.type === "works_at")).toHaveLength(2);
    // Re-adding the manual edge is still idempotent within its own provenance.
    const again = await addLink(storage, {
      source_slug: "people/alice",
      target_slug: "companies/acme",
      type: "works_at",
    });
    expect(again.created).toBe(false);
    expect((await linkRows()).filter((r) => r.type === "works_at")).toHaveLength(2);
  });
});

describe("backlink-boost mentions exclusion (by provenance)", () => {
  it("excludes link_source='mentions' rows from the inbound tally", async () => {
    await putPage(storage, { slug: "people/bob", type: "person" });
    // Intentional reference (manual) — counts.
    await addLink(storage, {
      source_slug: "people/bob",
      target_slug: "companies/acme",
      type: "related_to",
    });
    // Auto-mention (gazetteer-shaped) — must NOT count.
    await storage.engine().query(
      `INSERT INTO links (source_slug, target_slug, type, inferred_confidence,
                          link_kind, link_source)
       VALUES ('people/alice', 'companies/acme', 'mentions', 1.0, 'plain', 'mentions')`,
    );
    // Verb-derived typed edge — mentions provenance, must NOT count either
    // (the old type<>'mentions' filter missed these).
    await storage.engine().query(
      `INSERT INTO links (source_slug, target_slug, type, inferred_confidence,
                          link_kind, link_source)
       VALUES ('people/alice', 'companies/acme', 'works_at', 0.6, 'verb_ner', 'mentions')`,
    );
    const counts = await defaultBacklinkCounts(storage.engine(), ["companies/acme"]);
    expect(counts.get("companies/acme")).toBe(1);
  });
});
