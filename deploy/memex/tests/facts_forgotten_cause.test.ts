/**
 * Item 4 — structured forget cause (migration 062). A by-id forget stamps
 * `forgotten_cause = 'forget'`; a supersede/dedup path passes 'supersede'. The
 * free-text `forgotten_reason` audit note is unaffected.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { addFact } from "../src/core/facts.ts";
import { forgetFact } from "../src/core/facts-recall.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-forgotten-cause-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});
afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function seed(): Promise<number> {
  const r = await addFact(storage, { entity_slug: "people/alice", fact: "x" });
  return r.id as number;
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
