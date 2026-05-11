/**
 * Extract tests — seed chunks with embedded markdown, then re-extract
 * entities. Deletes stale mentions, inserts fresh ones from the extractor.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { extractAll } from "../src/core/extract.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-extract-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("extractAll", () => {
  it("populates entity_mentions for chunks that lacked them", async () => {
    const db = storage.raw();
    await db.exec(`
      INSERT INTO documents (id, source_path, title, frontmatter) VALUES
        ('d1', '/vault/a.md', 'A', '{"tags":["foo"]}'::jsonb);
      INSERT INTO chunks (id, document_id, chunk_index, content) VALUES
        ('d1c0', 'd1', 0, 'See [[Bar]] and #baz on 2026-01-01'),
        ('d1c1', 'd1', 1, 'plain text, no markup');
    `);
    const r = await extractAll(storage);
    expect(r.documents).toBe(1);
    expect(r.chunks).toBe(2);
    expect(r.mentionsBefore).toBe(0);
    expect(r.mentionsAfter).toBeGreaterThan(0);
    expect(r.errors).toEqual([]);

    // chunk 0: wikilink Bar + tag baz + tag foo (frontmatter) + date 2026-01-01 = 4
    const c0 = await db.query<{ c: number }>(
      "SELECT COUNT(*)::int AS c FROM entity_mentions WHERE chunk_id='d1c0'",
    );
    expect(c0.rows[0]!.c).toBe(4);

    // chunk 1: nothing extractable
    const c1 = await db.query<{ c: number }>(
      "SELECT COUNT(*)::int AS c FROM entity_mentions WHERE chunk_id='d1c1'",
    );
    expect(c1.rows[0]!.c).toBe(0);
  });

  it("replaces stale entity_mentions instead of accumulating", async () => {
    const db = storage.raw();
    await db.exec(`
      INSERT INTO documents (id, source_path, title) VALUES
        ('d1', '/vault/a.md', 'A');
      INSERT INTO chunks (id, document_id, chunk_index, content) VALUES
        ('d1c0', 'd1', 0, 'now points to [[New]]');
      INSERT INTO entities (id, type, name) VALUES
        ('wikilink:old', 'wikilink', 'Old');
      INSERT INTO entity_mentions (chunk_id, entity_id, surface_form)
        VALUES ('d1c0', 'wikilink:old', 'Old');
    `);
    const before = await db.query<{ c: number }>(
      "SELECT COUNT(*)::int AS c FROM entity_mentions WHERE chunk_id='d1c0'",
    );
    expect(before.rows[0]!.c).toBe(1);

    await extractAll(storage);

    const after = await db.query<{ name: string }>(
      `SELECT e.name FROM entity_mentions em
       JOIN entities e ON e.id = em.entity_id
       WHERE em.chunk_id='d1c0'`,
    );
    expect(after.rows.map((r) => r.name)).toEqual(["New"]);
  });

  it("respects maxDocs cap", async () => {
    const db = storage.raw();
    await db.exec(`
      INSERT INTO documents (id, source_path, title) VALUES
        ('d1', '/a.md', 'A'),
        ('d2', '/b.md', 'B'),
        ('d3', '/c.md', 'C');
      INSERT INTO chunks (id, document_id, chunk_index, content) VALUES
        ('d1c0', 'd1', 0, 'mentions [[X]]'),
        ('d2c0', 'd2', 0, 'mentions [[Y]]'),
        ('d3c0', 'd3', 0, 'mentions [[Z]]');
    `);
    const r = await extractAll(storage, { maxDocs: 2 });
    expect(r.documents).toBe(2);
    expect(r.chunks).toBe(2);
  });

  it("handles documents with zero chunks", async () => {
    const db = storage.raw();
    await db.exec(`
      INSERT INTO documents (id, source_path, title) VALUES
        ('d1', '/empty.md', 'Empty');
    `);
    const r = await extractAll(storage);
    expect(r.documents).toBe(0); // doc with no chunks is skipped before increment
    expect(r.chunks).toBe(0);
    expect(r.errors).toEqual([]);
  });
});
