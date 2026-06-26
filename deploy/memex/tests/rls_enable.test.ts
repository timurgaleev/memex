/**
 * Migration 049 — defensive Row-Level Security enable.
 *
 * Runs the real migration set on a fresh PGLite (whose default `postgres` role
 * holds BYPASSRLS, so the guard's IF branch fires) and asserts:
 *   - `relrowsecurity` flips on for the content + auth tables;
 *   - the `migrations` bookkeeping table is left untouched;
 *   - enabling RLS does not lock the migrating role out — every table stays
 *     readable and writable (the role bypasses RLS, and FORCE is not set).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGliteEngine } from "../src/core/engine/pglite.ts";
import { runMigrations } from "../src/core/migrate.ts";

const MIGRATIONS_DIR = join(import.meta.dir, "../src/core/migrations");

describe("migration 049 — RLS enable", () => {
  let tmp: string;
  let engine: PGliteEngine;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "rls049-"));
    engine = new PGliteEngine({ dbPath: join(tmp, "db") });
    await engine.ready();
    await runMigrations(engine, MIGRATIONS_DIR);
  });

  afterEach(async () => {
    await engine.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  const rowsec = async (table: string): Promise<boolean> => {
    const r = await engine.query<{ relrowsecurity: boolean }>(
      "SELECT relrowsecurity FROM pg_class WHERE relname = $1 AND relkind = 'r'",
      [table],
    );
    return r.rows[0]?.relrowsecurity ?? false;
  };

  it("enables RLS on the content + auth tables", async () => {
    for (const t of [
      "pages",
      "documents",
      "chunks",
      "links",
      "entity_facts",
      "timeline_events",
      "tags",
      "sources",
      "source_grants",
      "oauth_clients",
      "oauth_tokens",
      "access_tokens",
      "mcp_request_log",
    ]) {
      expect(await rowsec(t)).toBe(true);
    }
  });

  it("leaves the migrations bookkeeping table untouched", async () => {
    expect(await rowsec("migrations")).toBe(false);
  });

  it("does not lock the bypass role out of the enabled tables", async () => {
    // A read and a write both succeed: relrowsecurity is on, but the role
    // bypasses RLS (and is the owner), so no row is hidden and no insert blocked.
    const read = await engine.query<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM pages",
    );
    expect(read.rows[0]?.n).toBe(0);
    // kind='other' + path_prefix='tenant:<id>' is exactly how the `tenant add`
    // CLI provisions a tenant source (commands/tenant.ts), so this mirrors a
    // real write against an RLS-enabled table.
    const ins = await engine.query<{ id: string }>(
      `INSERT INTO sources (id, kind, path_prefix)
       VALUES ('rls-probe', 'other', 'tenant:rls-probe')
       ON CONFLICT DO NOTHING RETURNING id`,
    );
    expect(ins.rows[0]?.id).toBe("rls-probe");
  });
});
