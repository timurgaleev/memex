/**
 * Metadata substrate tables (migration 023) — existence + round-trip.
 *
 * tags / raw_data / config / ingest_log are lightweight metadata tables
 * with no app-layer logic yet (consumers land in later phases). This test
 * proves the migration creates them on a fresh PGLite Storage and that
 * each accepts a basic insert + select.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-metadata-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function tableExists(name: string): Promise<boolean> {
  const r = await storage.engine().query<{ n: number }>(
    `SELECT COUNT(*)::int AS n
       FROM information_schema.tables
      WHERE table_name = $1`,
    [name],
  );
  return Number(r.rows[0]!.n) > 0;
}

describe("metadata substrate tables", () => {
  it("creates tags, raw_data, config, ingest_log", async () => {
    for (const t of ["tags", "raw_data", "config", "ingest_log"]) {
      expect(await tableExists(t)).toBe(true);
    }
  });

  it("tags accepts a (slug, tag) round-trip", async () => {
    await storage
      .engine()
      .query(`INSERT INTO tags (slug, tag) VALUES ($1, $2)`, ["people/a", "founder"]);
    const r = await storage
      .engine()
      .query<{ tag: string }>(`SELECT tag FROM tags WHERE slug = $1`, ["people/a"]);
    expect(r.rows[0]!.tag).toBe("founder");
  });

  it("raw_data stores JSONB", async () => {
    await storage
      .engine()
      .query(
        `INSERT INTO raw_data (slug, source, data) VALUES ($1, $2, $3::jsonb)`,
        ["people/a", "x", JSON.stringify({ handle: "@a" })],
      );
    const r = await storage
      .engine()
      .query<{ data: { handle: string } }>(
        `SELECT data FROM raw_data WHERE slug = $1`,
        ["people/a"],
      );
    expect(r.rows[0]!.data.handle).toBe("@a");
  });

  it("config is key-addressable", async () => {
    await storage
      .engine()
      .query(`INSERT INTO config (key, value) VALUES ($1, $2)`, [
        "embedding_model",
        "titan-v2",
      ]);
    const r = await storage
      .engine()
      .query<{ value: string }>(`SELECT value FROM config WHERE key = $1`, [
        "embedding_model",
      ]);
    expect(r.rows[0]!.value).toBe("titan-v2");
  });

  it("ingest_log records a run with a pages_updated array", async () => {
    await storage
      .engine()
      .query(
        `INSERT INTO ingest_log (source_type, source_ref, pages_updated, summary)
         VALUES ($1, $2, $3::jsonb, $4)`,
        ["email", "msg-1", JSON.stringify(["people/a"]), "1 page"],
      );
    const r = await storage
      .engine()
      .query<{ pages_updated: string[] }>(
        `SELECT pages_updated FROM ingest_log WHERE source_ref = $1`,
        ["msg-1"],
      );
    expect(r.rows[0]!.pages_updated).toEqual(["people/a"]);
  });
});
