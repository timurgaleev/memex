/**
 * Take review surface: setTakeStatus (accept/reject, tenant-scoped) and
 * searchTakes (fuzzy claim search). Offline PGLite; no Bedrock.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import type { Engine } from "../src/core/engine/interface.ts";
import { setTakeStatus } from "../src/core/synthesis/takes.ts";
import { listTakes, searchTakes } from "../src/core/synthesis/reads.ts";

let tmp: string;
let storage: Storage;
let engine: Engine;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-take-review-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  engine = storage.engine();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

/** Seed a document owned by `sourceId` plus a queued take distilled from it. */
async function seedTake(
  docId: string,
  sourceId: string,
  takeKey: string,
  claim: string,
): Promise<void> {
  await engine.query(
    `INSERT INTO sources (id, kind, path_prefix) VALUES ($1, 'other', $2) ON CONFLICT (id) DO NOTHING`,
    [sourceId, `/vault/${sourceId}`],
  );
  await engine.query(
    `INSERT INTO documents (id, source_path, title, source_id) VALUES ($1, $2, $3, $4)`,
    [docId, `/vault/${docId}.md`, docId, sourceId],
  );
  await engine.query(
    `INSERT INTO synth_takes (take_key, source_ref, source_hash, prompt_version, claim_text, kind, weight, status, model_id)
     VALUES ($1, $2, 'h', 'v1', $3, 'judgment', 0.7, 'queued', 'fake')`,
    [takeKey, docId, claim],
  );
}

describe("setTakeStatus", () => {
  it("accepts a take, and list_takes(status:accepted) then surfaces it", async () => {
    await seedTake("d1", "alice", "t/1", "alpha holds");
    const r = await setTakeStatus(engine, "t/1", "accepted");
    expect(r.updated).toBe(true);
    const accepted = await listTakes(engine, { status: "accepted" });
    expect(accepted.map((t) => t.take_key)).toEqual(["t/1"]);
  });

  it("is a no-op for a take_key outside the caller's tenant", async () => {
    await seedTake("d1", "alice", "t/1", "alpha holds");
    // Bob tries to flip Alice's take — scoped out, nothing changes.
    const bob = await setTakeStatus(engine, "t/1", "rejected", ["bob"]);
    expect(bob.updated).toBe(false);
    const { rows } = await engine.query<{ status: string }>(
      `SELECT status FROM synth_takes WHERE take_key = 't/1'`,
    );
    expect(rows[0]?.status).toBe("queued");
    // Alice, the owner, succeeds.
    const alice = await setTakeStatus(engine, "t/1", "rejected", ["alice"]);
    expect(alice.updated).toBe(true);
  });

  it("reports updated:false for an unknown take_key", async () => {
    const r = await setTakeStatus(engine, "does-not-exist", "accepted");
    expect(r.updated).toBe(false);
  });
});

describe("searchTakes", () => {
  beforeEach(async () => {
    await seedTake("d1", "alice", "t/1", "aluminium prices will fall in Q3");
    await seedTake("d2", "alice", "t/2", "hiring freeze ends next spring");
    await seedTake("d3", "alice", "t/3", "the defence will crumble late");
  });

  it("ranks the closest claim first", async () => {
    const hits = await searchTakes(engine, { q: "aluminium prices" });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.take_key).toBe("t/1");
  });

  it("honors the limit", async () => {
    const hits = await searchTakes(engine, { q: "will", limit: 1 });
    expect(hits.length).toBe(1);
  });

  it("returns empty for a blank query", async () => {
    expect(await searchTakes(engine, { q: "   " })).toEqual([]);
  });

  it("scopes to the caller's tenant", async () => {
    const none = await searchTakes(engine, { q: "aluminium prices", sourceIds: ["bob"] });
    expect(none).toEqual([]);
    const mine = await searchTakes(engine, { q: "aluminium prices", sourceIds: ["alice"] });
    expect(mine[0]?.take_key).toBe("t/1");
  });
});
