/**
 * Single-fact recall + forget (soft-delete) over entity_facts.
 *
 * Covers: read-by-id of a live fact, null for unknown id, unknown-id forget,
 * the optional reason note, rejection of bad ids, and the structured forget
 * cause (migration 062): a by-id forget stamps `forgotten_cause = 'forget'`; a
 * supersede/dedup path passes 'supersede'. The free-text `forgotten_reason`
 * audit note is unaffected.
 *
 * One store for the file: a forget withdraws its claim for that entity, so
 * every seed writes to an entity of its own.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { addFact } from "../src/core/facts.ts";
import { forgetFact, recallFact } from "../src/core/facts-recall.ts";

let tmp: string;
let storage: Storage;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-facts-recall-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  // The tombstone columns ship as a dedicated migration; apply them
  // idempotently here so the test stands alone regardless of migration
  // ordering. Matches the migration's ADD COLUMN IF NOT EXISTS shape.
  await storage
    .engine()
    .query(
      "ALTER TABLE entity_facts ADD COLUMN IF NOT EXISTS forgotten_at TIMESTAMPTZ",
    );
  await storage
    .engine()
    .query(
      "ALTER TABLE entity_facts ADD COLUMN IF NOT EXISTS forgotten_reason TEXT",
    );
});

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

let seq = 0;

async function seedFact(fact = "ex-CFO at Acme", entity_slug = `people/alice-${++seq}`): Promise<number> {
  const r = await addFact(storage, { entity_slug, fact });
  expect(r.id).not.toBeNull();
  return r.id as number;
}

describe("recallFact", () => {
  it("reads a single live fact by id", async () => {
    const id = await seedFact("ex-CFO at Acme", "people/alice");
    const row = await recallFact(storage, id);
    expect(row).not.toBeNull();
    expect(row!.id).toBe(id);
    expect(row!.entity_slug).toBe("people/alice");
    expect(row!.fact).toBe("ex-CFO at Acme");
    expect(row!.forgotten_at).toBeNull();
  });

  it("returns null for an unknown id", async () => {
    expect(await recallFact(storage, 999999)).toBeNull();
  });

  it("rejects a non-positive / non-integer id", async () => {
    await expect(recallFact(storage, 0)).rejects.toThrow(/positive integer/);
    await expect(recallFact(storage, 1.5)).rejects.toThrow(/positive integer/);
  });
});

describe("forgetFact", () => {
  it("reports found=false for an unknown id", async () => {
    const r = await forgetFact(storage, 999999);
    expect(r).toEqual({ id: 999999, found: false, forgotten: false, withdrawn_duplicates: 0 });
  });

  it("stores the optional reason on the tombstoned row", async () => {
    const id = await seedFact();
    await forgetFact(storage, id, { reason: "superseded" });
    const r = await storage
      .engine()
      .query<{ forgotten_reason: string | null }>(
        "SELECT forgotten_reason FROM entity_facts WHERE id = $1",
        [id],
      );
    expect(r.rows[0]!.forgotten_reason).toBe("superseded");
  });

  it("rejects a non-positive id", async () => {
    await expect(forgetFact(storage, -1)).rejects.toThrow(/positive integer/);
  });

  it("the audit row survives a forget (not physically deleted)", async () => {
    const id = await seedFact();
    await forgetFact(storage, id);
    const r = await storage
      .engine()
      .query<{ id: number }>(
        "SELECT id FROM entity_facts WHERE id = $1",
        [id],
      );
    expect(r.rows.length).toBe(1);
  });
});

async function seed(): Promise<number> {
  return seedFact("x");
}

async function readCause(id: number): Promise<string | null> {
  const r = await storage
    .engine()
    .query<{ forgotten_cause: string | null }>(
      "SELECT forgotten_cause FROM entity_facts WHERE id = $1",
      [id],
    );
  return r.rows[0]!.forgotten_cause;
}

describe("forgotten_cause", () => {
  it("defaults to 'forget' on a plain forget", async () => {
    const id = await seed();
    await forgetFact(storage, id);
    expect(await readCause(id)).toBe("forget");
  });

  it("stamps 'supersede' when the caller passes that cause", async () => {
    const id = await seed();
    await forgetFact(storage, id, { cause: "supersede", reason: "superseded by #7" });
    expect(await readCause(id)).toBe("supersede");
    const r = await storage
      .engine()
      .query<{ forgotten_reason: string | null }>(
        "SELECT forgotten_reason FROM entity_facts WHERE id = $1",
        [id],
      );
    expect(r.rows[0]!.forgotten_reason).toBe("superseded by #7");
  });

  it("the CHECK constraint rejects an out-of-range cause via a direct write", async () => {
    const id = await seed();
    await expect(
      storage
        .engine()
        .query(
          "UPDATE entity_facts SET forgotten_cause = 'bogus' WHERE id = $1",
          [id],
        ),
    ).rejects.toThrow();
  });

  it("leaves forgotten_cause NULL on a live (un-forgotten) fact", async () => {
    const id = await seed();
    expect(await readCause(id)).toBeNull();
  });
});
