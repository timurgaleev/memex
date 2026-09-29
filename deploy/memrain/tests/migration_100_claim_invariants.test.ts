/**
 * Migration 100 — backfill the two ledger invariants over rows written before
 * anything enforced them: a NULL `kind` (invisible to confidence decay, so the
 * row never ages) and a NULL `written_by` (an unauditable claim).
 *
 * A fresh brain never carries such a row — the write paths now floor both — so
 * the legacy state is recreated AFTER the migrations run and the migration file
 * is executed a second time. Re-executing is itself the idempotency proof the
 * live deploy relies on: the runner replays nothing, but a hand re-run over a
 * brain that already has 1153 backfilled rows must not touch them.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGliteEngine } from "../src/core/engine/pglite.ts";
import { runMigrations } from "../src/core/migrate.ts";

const MIGRATIONS_DIR = join(import.meta.dir, "../src/core/migrations");
const MIGRATION_100 = readFileSync(
  join(MIGRATIONS_DIR, "100_entity_facts_claim_invariants.sql"),
  "utf8",
);

describe("migration 100 — every legacy claim ages and names a writer", () => {
  let tmp: string;
  let engine: PGliteEngine;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "mig100-"));
    engine = new PGliteEngine({ dbPath: join(tmp, "db") });
    await engine.ready();
    await runMigrations(engine, MIGRATIONS_DIR);
  });

  afterEach(async () => {
    await engine.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  /** Rows as the pre-invariant write paths left them. */
  const seedLegacy = async (): Promise<void> => {
    await engine.query(
      `INSERT INTO entity_facts (entity_slug, fact, confidence)
       VALUES ('people/alice', 'kindless and unattributed', 0.9)`,
    );
    // A take as the consolidate phase used to write it: writer named, kind blank.
    await engine.query(
      `INSERT INTO entity_facts (entity_slug, fact, confidence, written_by, consolidated)
       VALUES ('people/alice', 'immortal take', 0.8, 'facts-consolidate', true)`,
    );
    // A dimensional ontology row: its projection carries no writer at all, by
    // design, so the backfill must leave it alone.
    await engine.query(
      `INSERT INTO entity_facts (entity_slug, fact, confidence, kind, dimension, value, value_hash)
       VALUES ('people/alice', 'employer: Acme', 1.0, 'fact', 'employer', 'Acme', 'h1')`,
    );
  };

  const factRow = async (fact: string) =>
    (
      await engine.query<{ kind: string | null; written_by: string | null }>(
        `SELECT kind, written_by FROM entity_facts WHERE fact = $1`,
        [fact],
      )
    ).rows[0]!;

  it("stamps a decayable kind and a writer on the rows that lacked them", async () => {
    await seedLegacy();
    await engine.exec(MIGRATION_100);

    expect(await factRow("kindless and unattributed")).toEqual({
      kind: "belief",
      written_by: "unattributed",
    });
    // The take keeps its real writer and gains the kind decay needs.
    expect(await factRow("immortal take")).toEqual({
      kind: "belief",
      written_by: "facts-consolidate",
    });
  });

  it("leaves the dimensional projection's writer alone", async () => {
    await seedLegacy();
    await engine.exec(MIGRATION_100);
    // Scoped to the fact ledger: ontology rows are written by a path that
    // records no writer, so backfilling them would assert an invariant the next
    // observation breaks.
    expect(await factRow("employer: Acme")).toEqual({
      kind: "fact",
      written_by: null,
    });
  });

  it("is a no-op on a re-run: it never rewrites a stated value", async () => {
    await engine.query(
      `INSERT INTO entity_facts (entity_slug, fact, confidence, kind, written_by)
       VALUES ('people/alice', 'stated', 0.9, 'event', 'capture-cli')`,
    );
    await engine.exec(MIGRATION_100);
    await engine.exec(MIGRATION_100);
    expect(await factRow("stated")).toEqual({
      kind: "event",
      written_by: "capture-cli",
    });
  });

  it("leaves nothing kindless or unattributed behind", async () => {
    await seedLegacy();
    await engine.exec(MIGRATION_100);
    const r = await engine.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM entity_facts
        WHERE dimension IS NULL AND (kind IS NULL OR written_by IS NULL)`,
    );
    expect(r.rows[0]!.n).toBe(0);
  });
});
