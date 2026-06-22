/**
 * Single-fact recall + forget (soft-delete) over entity_facts.
 *
 * Covers: read-by-id of a live fact, null for unknown id, forget tombstoning,
 * recall hiding a forgotten fact, idempotent double-forget, unknown-id forget,
 * the optional reason note, and rejection of bad ids.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { addFact } from "../src/core/facts.ts";
import { forgetFact, recallFact } from "../src/core/facts-recall.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
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

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function seedFact(fact = "ex-CFO at Acme"): Promise<number> {
  const r = await addFact(storage, { entity_slug: "people/alice", fact });
  expect(r.id).not.toBeNull();
  return r.id as number;
}

describe("recallFact", () => {
  it("reads a single live fact by id", async () => {
    const id = await seedFact();
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
  it("tombstones a live fact and hides it from recall", async () => {
    const id = await seedFact();
    const r = await forgetFact(storage, id);
    expect(r).toEqual({ id, found: true, forgotten: true });
    expect(await recallFact(storage, id)).toBeNull();
  });

  it("is idempotent: a second forget is a no-op", async () => {
    const id = await seedFact();
    await forgetFact(storage, id);
    const second = await forgetFact(storage, id);
    expect(second).toEqual({ id, found: true, forgotten: false });
  });

  it("reports found=false for an unknown id", async () => {
    const r = await forgetFact(storage, 999999);
    expect(r).toEqual({ id: 999999, found: false, forgotten: false });
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
