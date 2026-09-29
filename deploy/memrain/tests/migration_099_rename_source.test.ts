/**
 * Migration 099 — rename the `obsidian-vault` source to `memory`.
 *
 * A fresh brain never carries the legacy row, so the migration is a no-op
 * there. To test the real path the legacy state is recreated AFTER the
 * migrations run (source row + a document + its chunk + a PAT grant naming it)
 * and the migration file is executed a second time. Re-executing is itself the
 * idempotency proof the deploy relies on: the runner replays nothing, but a
 * hand re-run must not corrupt a renamed brain.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGliteEngine } from "../src/core/engine/pglite.ts";
import { runMigrations } from "../src/core/migrate.ts";

const MIGRATIONS_DIR = join(import.meta.dir, "../src/core/migrations");
const MIGRATION_099 = readFileSync(
  join(MIGRATIONS_DIR, "099_rename_vault_source_to_memory.sql"),
  "utf8",
);

describe("migration 099 — obsidian-vault becomes memory", () => {
  let tmp: string;
  let engine: PGliteEngine;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "mig099-"));
    engine = new PGliteEngine({ dbPath: join(tmp, "db") });
    await engine.ready();
    await runMigrations(engine, MIGRATIONS_DIR);
  });

  afterEach(async () => {
    await engine.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  /** Recreate the pre-rename world: legacy source + a doc, chunk and grant. */
  const seedLegacy = async (): Promise<void> => {
    await engine.query(
      `INSERT INTO sources (id, kind, path_prefix, sync_policy, indexed_policy,
                            rate_limit_per_minute, respect_quiet_hours, boost_weight)
       VALUES ('obsidian-vault', 'vault', '/vault', 'synced', 'verbatim', 60, false, 1.00)`,
    );
    // `documents.id` / `chunks.id` are app-assigned text ids, no sequence.
    await engine.query(
      `INSERT INTO documents (id, source_id, source_path, title)
       VALUES ('doc-1', 'obsidian-vault', '/vault/20-projects/note.md', 'Note')`,
    );
    await engine.query(
      `INSERT INTO chunks (id, document_id, chunk_index, content, source_id)
       VALUES ('chunk-1', 'doc-1', 0, 'body', 'obsidian-vault')`,
    );
    await engine.query(
      `INSERT INTO access_tokens (name, token_hash, permissions)
       VALUES ('t', 'hash', '{"source_id":["timur","obsidian-vault","gcal"]}'::jsonb)`,
    );
  };

  const one = async <T>(sql: string): Promise<T> =>
    (await engine.query<T>(sql)).rows[0] as T;

  it("repoints the source, its rows and the stored paths", async () => {
    await seedLegacy();
    await engine.query(MIGRATION_099);

    const src = await one<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM sources WHERE id = 'obsidian-vault'`,
    );
    expect(src.n).toBe(0);

    const renamed = await one<{ path_prefix: string }>(
      `SELECT path_prefix FROM sources WHERE id = 'memory'`,
    );
    expect(renamed.path_prefix).toBe("/memory");

    const doc = await one<{ source_id: string; source_path: string }>(
      `SELECT source_id, source_path FROM documents LIMIT 1`,
    );
    expect(doc.source_id).toBe("memory");
    // The rewrite swaps the prefix and keeps the rest of the path intact —
    // that is what makes the next index pass match instead of duplicate.
    expect(doc.source_path).toBe("/memory/20-projects/note.md");

    const chunk = await one<{ source_id: string }>(
      `SELECT source_id FROM chunks LIMIT 1`,
    );
    expect(chunk.source_id).toBe("memory");
  });

  it("renames the source inside a PAT grant without touching its siblings", async () => {
    await seedLegacy();
    await engine.query(MIGRATION_099);

    const tok = await one<{ ids: string }>(
      `SELECT permissions->'source_id' AS ids FROM access_tokens WHERE name = 't'`,
    );
    expect(JSON.parse(JSON.stringify(tok.ids))).toEqual([
      "timur",
      "memory",
      "gcal",
    ]);
  });

  it("is a no-op on a brain that has already been renamed", async () => {
    await seedLegacy();
    await engine.query(MIGRATION_099);
    await engine.query(MIGRATION_099);

    const src = await one<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM sources WHERE id = 'memory'`,
    );
    expect(src.n).toBe(1);
    const doc = await one<{ source_path: string }>(
      `SELECT source_path FROM documents LIMIT 1`,
    );
    expect(doc.source_path).toBe("/memory/20-projects/note.md");
  });

  it("is a no-op on a fresh brain that never had the legacy source", async () => {
    await engine.query(MIGRATION_099);
    const src = await one<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM sources WHERE id IN ('memory', 'obsidian-vault')`,
    );
    expect(src.n).toBe(0);
  });
});
