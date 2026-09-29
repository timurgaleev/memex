/**
 * Backlinks tests — seed entity_mentions directly so we don't pay for
 * Bedrock embeds. Verify ranking + limit.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { findBacklinks } from "../src/core/backlinks.ts";
import { entityId } from "../src/core/entities.ts";

let tmp: string;
let storage: Storage;

async function seed() {
  const db = storage.raw();
  // Two docs, two chunks each.
  await db.exec(`
    INSERT INTO documents (id, source_path, title) VALUES
      ('d1', '/vault/a.md', 'A note'),
      ('d2', '/vault/b.md', 'B note'),
      ('d3', '/vault/c.md', 'C note');
    INSERT INTO chunks (id, document_id, chunk_index, content) VALUES
      ('d1c0', 'd1', 0, 'mentions [[Foo]] once'),
      ('d1c1', 'd1', 1, 'mentions [[Foo]] again'),
      ('d2c0', 'd2', 0, 'mentions [[Foo]] once'),
      ('d3c0', 'd3', 0, 'mentions only [[Bar]]');
  `);
  const fooId = entityId("wikilink", "Foo");
  const barId = entityId("wikilink", "Bar");
  await db.exec(`
    INSERT INTO entities (id, type, name) VALUES
      ('${fooId}', 'wikilink', 'Foo'),
      ('${barId}', 'wikilink', 'Bar');
    INSERT INTO entity_mentions (chunk_id, entity_id, surface_form) VALUES
      ('d1c0', '${fooId}', 'Foo'),
      ('d1c1', '${fooId}', 'Foo'),
      ('d2c0', '${fooId}', 'Foo'),
      ('d3c0', '${barId}', 'Bar');
  `);
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-backlinks-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  await seed();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("findBacklinks", () => {
  it("returns docs that mention a wikilink, ordered by mention count", async () => {
    const r = await findBacklinks(storage, "Foo");
    expect(r.length).toBe(2);
    expect(r[0]!.documentId).toBe("d1"); // 2 mentions
    expect(r[0]!.mentionCount).toBe(2);
    expect(r[1]!.documentId).toBe("d2");
    expect(r[1]!.mentionCount).toBe(1);
  });

  it("returns nothing for an unknown entity", async () => {
    const r = await findBacklinks(storage, "Nonexistent");
    expect(r).toEqual([]);
  });

  it("respects limit", async () => {
    const r = await findBacklinks(storage, "Foo", { limit: 1 });
    expect(r.length).toBe(1);
    expect(r[0]!.documentId).toBe("d1");
  });

  it("rejects out-of-range limit", async () => {
    await expect(findBacklinks(storage, "Foo", { limit: 0 })).rejects.toThrow(/limit/);
    await expect(findBacklinks(storage, "Foo", { limit: 9999 })).rejects.toThrow(/limit/);
  });

  it("filters by entity type", async () => {
    const r = await findBacklinks(storage, "Bar", { type: "wikilink" });
    expect(r.length).toBe(1);
    expect(r[0]!.documentId).toBe("d3");
  });
});
