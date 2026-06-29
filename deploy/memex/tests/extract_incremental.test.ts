/**
 * Incremental entity extraction (migration 054 watermark) — the cycle's extract
 * phase no longer re-walks the whole corpus every tick. A doc is processed only
 * when never extracted, the extractor version bumped, or it was re-indexed
 * since. `--all` forces a full walk. Mirrors the reference's incremental extract.
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
  tmp = mkdtempSync(join(tmpdir(), "memex-extract-inc-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  await storage.raw().exec(`
    INSERT INTO documents (id, source_path, title, frontmatter) VALUES
      ('d1', '/vault/a.md', 'A', '{}'::jsonb),
      ('d2', '/vault/b.md', 'B', '{}'::jsonb);
    INSERT INTO chunks (id, document_id, chunk_index, content) VALUES
      ('d1c0', 'd1', 0, 'see [[Foo]]'),
      ('d2c0', 'd2', 0, 'see [[Bar]]');
  `);
});
afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("incremental extract (watermark)", () => {
  it("first run walks all (NULL watermark); second run walks none", async () => {
    const r1 = await extractAll(storage);
    expect(r1.documents).toBe(2); // both stale (entities_extracted_at NULL)

    const r2 = await extractAll(storage);
    expect(r2.documents).toBe(0); // both stamped → nothing stale
  });

  it("re-indexing a doc (updated_at advances) re-stales only it", async () => {
    await extractAll(storage);
    // Simulate a re-index of d1: bump its updated_at past its watermark.
    await storage.raw().query(
      "UPDATE documents SET updated_at = NOW() + INTERVAL '1 hour' WHERE id = $1",
      ["d1"],
    );
    const r = await extractAll(storage);
    expect(r.documents).toBe(1); // only d1
  });

  it("a doc edited BEFORE the extractor version converges (GREATEST stamp)", async () => {
    // updated_at predates ENTITY_EXTRACTOR_VERSION_TS (2026-06-29). Stamping the
    // raw updated_at would leave the version arm true forever; GREATEST lifts it.
    await storage.raw().query(
      "UPDATE documents SET updated_at = '2026-01-01T00:00:00Z' WHERE id = $1",
      ["d1"],
    );
    await extractAll(storage); // stamps d1 with GREATEST(2026-01-01, version)
    const r = await extractAll(storage);
    expect(r.documents).toBe(0); // d1 did NOT re-stale on the version arm
  });

  it("--all forces a full walk regardless of watermark", async () => {
    await extractAll(storage); // stamps both
    const r = await extractAll(storage, { all: true });
    expect(r.documents).toBe(2); // forced full walk
  });
});
