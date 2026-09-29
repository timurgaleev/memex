/**
 * Migration 103 — delete/restore markers an unscoped writer left under `default`
 * move to the source that owns their page; tags stay where they are. The pre-fix state is
 * recreated after the migrations run and the file is executed again, which also
 * proves a re-run is harmless.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGliteEngine } from "../src/core/engine/pglite.ts";
import { runMigrations } from "../src/core/migrate.ts";

const MIGRATIONS_DIR = join(import.meta.dir, "../src/core/migrations");
const MIGRATION_103 = readFileSync(join(MIGRATIONS_DIR, "103_derived_rows_follow_page_owner.sql"), "utf8");

describe("migration 103 — derived rows follow the page owner", () => {
  let tmp: string;
  let engine: PGliteEngine;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "mig103-"));
    engine = new PGliteEngine({ dbPath: join(tmp, "db") });
    await engine.ready();
    await runMigrations(engine, MIGRATIONS_DIR);
    await engine.query(`INSERT INTO sources (id, kind, path_prefix) VALUES ('tenant-a', 'other', '/a/')`);
    for (const [slug, source] of [["notes/a", "tenant-a"], ["notes/d", "default"]] as const) {
      await engine.query(
        `INSERT INTO pages (slug, type, title, markdown_body, content_hash, source_id)
         VALUES ($1, 'note', $1, 'body', 'h', $2)`,
        [slug, source],
      );
    }
    // Pre-fix rows: an unscoped operator's tag, a tag the owner also holds, and
    // a delete + restore marker pair, all stamped `default` on tenant-a's page.
    await engine.query(`INSERT INTO tags (slug, tag, source_id) VALUES ('notes/a', 'operator-tag', 'default')`);
    await engine.query(`INSERT INTO tags (slug, tag, source_id) VALUES ('notes/a', 'shared', 'default')`);
    await engine.query(`INSERT INTO tags (slug, tag, source_id) VALUES ('notes/a', 'shared', 'tenant-a')`);
    await engine.query(`INSERT INTO tags (slug, tag, source_id) VALUES ('notes/d', 'default-page-tag', 'default')`);
    let n = 10;
    for (const marker of [{ deleted_at: "2026-01-01" }, { restored_at: "2026-01-02" }]) {
      await engine.query(
        `INSERT INTO page_versions (slug, version_n, hash_prev, hash_new, body_snapshot, compiled_truth_snapshot, source_id)
         VALUES ('notes/a', $1, 'h', 'h', '', $2::jsonb, 'default')`,
        [n++, JSON.stringify(marker)],
      );
    }
    await engine.query(
      `INSERT INTO page_versions (slug, version_n, hash_prev, hash_new, body_snapshot, compiled_truth_snapshot, source_id)
       VALUES ('notes/d', 1, 'h', 'h', '', '{"deleted_at":"2026-01-01"}'::jsonb, 'default')`,
    );
  });

  afterEach(async () => {
    await engine.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("moves tenant-page markers, leaves tags and default pages alone", async () => {
    await engine.exec(MIGRATION_103);
    await engine.exec(MIGRATION_103);
    const tags = await engine.query<{ slug: string; tag: string; source_id: string }>(
      `SELECT slug, tag, source_id FROM tags ORDER BY slug, tag, source_id`,
    );
    expect(tags.rows).toEqual([
      { slug: "notes/a", tag: "operator-tag", source_id: "default" },
      { slug: "notes/a", tag: "shared", source_id: "default" },
      { slug: "notes/a", tag: "shared", source_id: "tenant-a" },
      { slug: "notes/d", tag: "default-page-tag", source_id: "default" },
    ]);
    const markers = await engine.query<{ slug: string; source_id: string }>(
      `SELECT slug, source_id FROM page_versions WHERE body_snapshot = '' ORDER BY slug, version_n`,
    );
    expect(markers.rows).toEqual([
      { slug: "notes/a", source_id: "tenant-a" },
      { slug: "notes/a", source_id: "tenant-a" },
      { slug: "notes/d", source_id: "default" },
    ]);
  });
});
