/**
 * Migration 104 — code edges and volunteer events written with no source take
 * the source of their document / page; rows with nothing to inherit stay NULL.
 * The file is executed again after seeding, which also proves a re-run is safe.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGliteEngine } from "../src/core/engine/pglite.ts";
import { runMigrations } from "../src/core/migrate.ts";

const MIGRATIONS_DIR = join(import.meta.dir, "../src/core/migrations");
const MIGRATION_104 = readFileSync(join(MIGRATIONS_DIR, "104_code_edges_and_volunteer_events_source.sql"), "utf8");

describe("migration 104 — code edges and volunteer events inherit their source", () => {
  let tmp: string;
  let engine: PGliteEngine;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "mig104-"));
    engine = new PGliteEngine({ dbPath: join(tmp, "db") });
    await engine.ready();
    await runMigrations(engine, MIGRATIONS_DIR);
    await engine.query(`INSERT INTO sources (id, kind, path_prefix) VALUES ('tenant-a', 'other', '/a/')`);
    await engine.query(`INSERT INTO documents (id, source_path, source_id) VALUES ('doc-a', '/a/x.ts', 'tenant-a')`);
    await engine.query(`INSERT INTO documents (id, source_path, source_id) VALUES ('doc-none', '/x/y.ts', NULL)`);
    await engine.query(`INSERT INTO chunks (id, document_id, chunk_index, content) VALUES ('ch-a', 'doc-a', 0, 'a'), ('ch-none', 'doc-none', 0, 'n')`);
    await engine.query(
      `INSERT INTO code_edges_symbol (from_chunk_id, from_symbol_qualified, to_symbol_qualified, edge_type, source_id)
       VALUES ('ch-a', 'f', 'g', 'calls', NULL), ('ch-none', 'h', 'i', 'calls', NULL)`,
    );
    await engine.query(
      `INSERT INTO pages (slug, type, title, markdown_body, content_hash, source_id)
       VALUES ('notes/a', 'note', 'A', 'a', 'h', 'tenant-a')`,
    );
    await engine.query(
      `INSERT INTO context_volunteer_events (source_id, slug, confidence, match_arm, rationale, channel)
       VALUES (NULL, 'notes/a', 1, 'title', 'r', 'op'), (NULL, 'notes/gone', 1, 'title', 'r', 'op')`,
    );
  });

  afterEach(async () => {
    await engine.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("fills sources that can be inherited and leaves the rest NULL", async () => {
    await engine.exec(MIGRATION_104);
    await engine.exec(MIGRATION_104);
    const edges = await engine.query<{ from_chunk_id: string; source_id: string | null }>(
      `SELECT from_chunk_id, source_id FROM code_edges_symbol ORDER BY from_chunk_id`,
    );
    expect(edges.rows).toEqual([
      { from_chunk_id: "ch-a", source_id: "tenant-a" },
      { from_chunk_id: "ch-none", source_id: null },
    ]);
    const events = await engine.query<{ slug: string; source_id: string | null }>(
      `SELECT slug, source_id FROM context_volunteer_events ORDER BY slug`,
    );
    expect(events.rows).toEqual([
      { slug: "notes/a", source_id: "tenant-a" },
      { slug: "notes/gone", source_id: null },
    ]);
  });
});
