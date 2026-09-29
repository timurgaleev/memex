/**
 * Migrations 096 (timeline event projection) + 097 (entity_facts ontology).
 *
 * Asserts the additive columns land and that both dedup keys enforce
 * idempotency: identical ontology claims collapse (including the NULL-source
 * case that validates the NULLS NOT DISTINCT choice), and a projected timeline
 * row is unique per (page, UTC day).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGliteEngine } from "../src/core/engine/pglite.ts";
import { runMigrations } from "../src/core/migrate.ts";

const MIGRATIONS_DIR = join(import.meta.dir, "../src/core/migrations");

describe("migrations 096/097 — chronicle projection + ontology", () => {
  let tmp: string;
  let engine: PGliteEngine;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "chronicle-"));
    engine = new PGliteEngine({ dbPath: join(tmp, "db") });
    await engine.ready();
    await runMigrations(engine, MIGRATIONS_DIR);
  });

  afterEach(async () => {
    await engine.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  const hasColumn = async (table: string, column: string): Promise<boolean> => {
    const r = await engine.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n
         FROM information_schema.columns
        WHERE table_name = $1 AND column_name = $2`,
      [table, column],
    );
    return (r.rows[0]?.n ?? 0) > 0;
  };

  it("adds the projection + ontology columns", async () => {
    expect(await hasColumn("timeline_events", "event_slug")).toBe(true);
    for (const col of ["dimension", "value", "value_hash", "dim_status"]) {
      expect(await hasColumn("entity_facts", col)).toBe(true);
    }
  });

  it("dedups identical dimensional claims from the same source", async () => {
    const insert = () =>
      engine.query(
        `INSERT INTO entity_facts
           (entity_slug, fact, kind, source_id, source_slug,
            dimension, value, value_hash)
         VALUES ('people/alice', 'employer is Acme', 'fact', 'default',
                 'meetings/2026-01-10', 'employer', 'Acme', 'hash-acme')`,
      );
    await insert();
    await expect(insert()).rejects.toThrow();
  });

  it("dedups identical claims even when source_slug is NULL (NULLS NOT DISTINCT)", async () => {
    const insert = () =>
      engine.query(
        `INSERT INTO entity_facts
           (entity_slug, fact, kind, source_id, source_slug,
            dimension, value, value_hash)
         VALUES ('people/bob', 'role is CTO', 'fact', 'default',
                 NULL, 'role', 'CTO', 'hash-cto')`,
      );
    await insert();
    await expect(insert()).rejects.toThrow();
  });

  it("lets a value recur once the prior claim is retired (dedup covers OPEN rows only)", async () => {
    const insertOpenA = () =>
      engine.query(
        `INSERT INTO entity_facts
           (entity_slug, fact, kind, source_id, source_slug,
            dimension, value, value_hash)
         VALUES ('people/dana', 'employer is Acme', 'fact', 'default',
                 'meetings/x', 'employer', 'Acme', 'hash-acme')`,
      );
    await insertOpenA();
    // A duplicate OPEN claim is still rejected while the first is live.
    await expect(insertOpenA()).rejects.toThrow();
    // Retire the live claim (dana moved A -> B): it leaves the OPEN-only key.
    await engine.query(
      `UPDATE entity_facts SET valid_until = DATE '2026-02-01'
        WHERE entity_slug = 'people/dana' AND value_hash = 'hash-acme'`,
    );
    // The value may now recur (dana returns to Acme) — no collision with history.
    await insertOpenA();
    const live = await engine.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM entity_facts
        WHERE entity_slug = 'people/dana' AND value_hash = 'hash-acme'
          AND valid_until IS NULL AND forgotten_at IS NULL`,
    );
    expect(live.rows[0]?.n).toBe(1);
  });

  it("admits a 'consolidate' corroboration tombstone but still rejects a bogus cause", async () => {
    // A corroboration row: already retired (forgotten_at set), links the
    // surviving claim via consolidated_into, cause='consolidate'.
    await engine.query(
      `INSERT INTO entity_facts
         (entity_slug, fact, kind, source_id, forgotten_at, forgotten_cause,
          consolidated_into)
       VALUES ('people/carol', 'employer is Acme', 'fact', 'default',
               NOW(), 'consolidate', 1)`,
    );
    await expect(
      engine.query(
        `INSERT INTO entity_facts
           (entity_slug, fact, kind, source_id, forgotten_at, forgotten_cause)
         VALUES ('people/carol', 'employer is Acme', 'fact', 'default',
                 NOW(), 'not-a-cause')`,
      ),
    ).rejects.toThrow();
  });

  it("keeps one projected timeline row per page per UTC day", async () => {
    await engine.query(
      `INSERT INTO pages (slug, type, content_hash)
       VALUES ('events/launch', 'event', 'h0')`,
    );
    const insert = (event: string) =>
      engine.query(
        `INSERT INTO timeline_events
           (slug, occurred_at, event, source_id, event_slug)
         VALUES ('events/launch', TIMESTAMPTZ '2026-01-15 09:00:00+00',
                 $1, 'default', 'events/launch')`,
        [event],
      );
    await insert("Project launched (morning)");
    // Same page, same UTC calendar day — the projection key rejects the second.
    await expect(insert("Project launched (evening)")).rejects.toThrow();
  });

  it("projects the same page/day independently per tenant (key leads with source_id)", async () => {
    await engine.query(
      `INSERT INTO pages (slug, type, content_hash)
       VALUES ('events/launch', 'event', 'h0')`,
    );
    await engine.query(
      `INSERT INTO sources (id, kind, path_prefix)
       VALUES ('tenant-b', 'other', 'tenant:tenant-b') ON CONFLICT DO NOTHING`,
    );
    const insert = (source: string) =>
      engine.query(
        `INSERT INTO timeline_events
           (slug, occurred_at, event, source_id, event_slug)
         VALUES ('events/launch', TIMESTAMPTZ '2026-01-15 09:00:00+00',
                 'Project launched', $1, 'events/launch')`,
        [source],
      );
    await insert("default");
    // Same page + same UTC day but a different tenant — must NOT collide.
    await insert("tenant-b");
    const n = await engine.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM timeline_events WHERE event_slug = 'events/launch'`,
    );
    expect(n.rows[0]?.n).toBe(2);
  });
});
