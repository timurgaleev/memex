/**
 * Migration 095 — search_path hardening.
 *
 * Runs the migration set on a fresh PGLite and asserts that the two
 * trigger / event-trigger functions carry a pinned `search_path` in their
 * catalog config (`pg_proc.proconfig`), and that re-running the migrations
 * applies nothing (idempotency).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGliteEngine } from "../src/core/engine/pglite.ts";
import { runMigrations } from "../src/core/migrate.ts";

const MIGRATIONS_DIR = join(import.meta.dir, "../src/core/migrations");

describe("migration 095 — search_path hardening", () => {
  let tmp: string;
  let engine: PGliteEngine;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "searchpath095-"));
    engine = new PGliteEngine({ dbPath: join(tmp, "db") });
    await engine.ready();
    await runMigrations(engine, MIGRATIONS_DIR);
  });

  afterEach(async () => {
    await engine.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("pins search_path on the trigger + event-trigger functions", async () => {
    const r = await engine.query<{ proname: string; proconfig: string[] | null }>(
      `SELECT proname, proconfig
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND proname IN ('chunks_update_search_vector', 'auto_enable_rls')
        ORDER BY proname`,
    );
    expect(r.rows.length).toBe(2);
    for (const row of r.rows) {
      expect(JSON.stringify(row.proconfig)).toContain("search_path=");
    }
  });

  it("is idempotent — a second run applies nothing", async () => {
    const result = await runMigrations(engine, MIGRATIONS_DIR);
    expect(result.applied.length).toBe(0);
  });
});
