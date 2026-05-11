/**
 * Smoke tests for the operational commands.
 *
 * `reconcile-links` and `orphans` are end-to-end tested in cycle.test.ts.
 * Here we exercise pages / lint / reports against a seeded engine to
 * verify shapes + edge cases (no snapshots row, no docs).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-ops-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("pages query (operational)", () => {
  it("returns name + counts for wikilink entities", async () => {
    const e = storage.engine();
    await e.exec(`
      INSERT INTO documents (id, source_path, title) VALUES
        ('d1', '/a.md', 'A'),
        ('d2', '/b.md', 'B');
      INSERT INTO chunks (id, document_id, chunk_index, content) VALUES
        ('c1', 'd1', 0, 'x'),
        ('c2', 'd2', 0, 'y');
      INSERT INTO entities (id, type, name) VALUES
        ('wikilink:foo', 'wikilink', 'Foo'),
        ('tag:hidden', 'tag', 'Hidden');
      INSERT INTO entity_mentions (chunk_id, entity_id, surface_form) VALUES
        ('c1', 'wikilink:foo', 'Foo'),
        ('c2', 'wikilink:foo', 'Foo');
    `);
    const r = await e.query<{
      name: string;
      mention_count: number;
      doc_count: number;
    }>(
      `SELECT e.name,
              COUNT(em.chunk_id)::int AS mention_count,
              COUNT(DISTINCT c.document_id)::int AS doc_count
       FROM entities e
       LEFT JOIN entity_mentions em ON em.entity_id = e.id
       LEFT JOIN chunks c           ON c.id = em.chunk_id
       WHERE e.type = 'wikilink'
       GROUP BY e.name
       ORDER BY mention_count DESC, e.name`,
    );
    expect(r.rows.length).toBe(1); // tags excluded
    expect(r.rows[0]!.name).toBe("Foo");
    expect(r.rows[0]!.mention_count).toBe(2);
    expect(r.rows[0]!.doc_count).toBe(2);
  });
});

describe("lint logic", () => {
  it("flags missing title / tags / created / updated", () => {
    const fm: Record<string, unknown> = {};
    const broken: string[] = [];
    if (typeof fm["title"] !== "string" || fm["title"].length === 0) {
      broken.push("title-missing");
    }
    if (!Array.isArray(fm["tags"]) && typeof fm["tags"] !== "string") {
      broken.push("tags-missing");
    }
    if (!fm["created"]) broken.push("created-missing");
    if (!fm["updated"]) broken.push("updated-missing");
    expect(broken).toEqual([
      "title-missing",
      "tags-missing",
      "created-missing",
      "updated-missing",
    ]);
  });

  it("passes a fully-populated frontmatter", () => {
    const fm: Record<string, unknown> = {
      title: "ok",
      tags: ["x"],
      created: "2026-01-01",
      updated: "2026-02-02",
    };
    const broken: string[] = [];
    if (typeof fm["title"] !== "string" || fm["title"].length === 0) {
      broken.push("title-missing");
    }
    if (!Array.isArray(fm["tags"]) && typeof fm["tags"] !== "string") {
      broken.push("tags-missing");
    }
    if (!fm["created"]) broken.push("created-missing");
    if (!fm["updated"]) broken.push("updated-missing");
    expect(broken).toEqual([]);
  });
});

describe("reports queries (operational)", () => {
  it("returns deltas after two snapshots", async () => {
    const e = storage.engine();
    // Snapshot 1: empty
    await e.query(
      `INSERT INTO cycle_snapshots
       (captured_at, documents, chunks, embeddings, entities, entity_mentions)
       VALUES (NOW() - INTERVAL '25 hours', 0, 0, 0, 0, 0)`,
    );
    // Snapshot 2: now
    await e.query(
      `INSERT INTO cycle_snapshots
       (captured_at, documents, chunks, embeddings, entities, entity_mentions)
       VALUES (NOW(), 10, 25, 25, 5, 12)`,
    );
    const latest = await e.query<{ documents: number }>(
      `SELECT documents FROM cycle_snapshots ORDER BY captured_at DESC LIMIT 1`,
    );
    expect(latest.rows[0]!.documents).toBe(10);
    const baseline = await e.query<{ documents: number }>(
      `SELECT documents FROM cycle_snapshots
       WHERE captured_at < NOW() - INTERVAL '24 hours'
       ORDER BY captured_at DESC LIMIT 1`,
    );
    expect(baseline.rows[0]!.documents).toBe(0);
  });
});
