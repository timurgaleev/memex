/**
 * Fact-text embedding (migration 038) -- the embed-facts backfill phase + the
 * semantic query-ranking it powers in entityRecall. Offline: a deterministic
 * stub embedder stands in for Bedrock Titan.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { addFact, entityRecall } from "../src/core/facts.ts";
import { embedFactsPhase } from "../src/core/cycle/embed-facts.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-factembed-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});
afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

/**
 * Deterministic 1024-dim stub embedder: a near-one-hot vector keyed off the
 * first recognized keyword, so cosine distance is fully controllable in tests.
 */
function stubEmbed(text: string): Promise<number[]> {
  const v = new Array(1024).fill(0);
  const t = text.toLowerCase();
  if (t.includes("alpha")) v[0] = 1;
  else if (t.includes("beta")) v[1] = 1;
  else v[2] = 1;
  return Promise.resolve(v);
}

async function embeddingCount(slug: string): Promise<number> {
  const r = await storage.engine().query<{ c: number }>(
    `SELECT COUNT(*)::int AS c FROM entity_facts
      WHERE entity_slug = $1 AND embedding IS NOT NULL`,
    [slug],
  );
  return r.rows[0]?.c ?? 0;
}

describe("embedFactsPhase", () => {
  it("embeds facts whose embedding is NULL", async () => {
    await addFact(storage, { entity_slug: "people/alice", fact: "alpha matters" });
    await addFact(storage, { entity_slug: "people/alice", fact: "beta too" });
    const res = await embedFactsPhase(storage.engine(), { embed: stubEmbed });
    expect(res.scanned).toBe(2);
    expect(res.embedded).toBe(2);
    expect(res.errors).toHaveLength(0);
    expect(await embeddingCount("people/alice")).toBe(2);
  });

  it("is incremental -- a re-run skips already-embedded facts", async () => {
    await addFact(storage, { entity_slug: "people/alice", fact: "alpha matters" });
    await embedFactsPhase(storage.engine(), { embed: stubEmbed });
    const second = await embedFactsPhase(storage.engine(), { embed: stubEmbed });
    expect(second.scanned).toBe(0); // embedding already set
    expect(second.embedded).toBe(0);
  });

  it("skips whitespace-only facts (they would fail embedText forever)", async () => {
    await addFact(storage, { entity_slug: "people/alice", fact: "real fact" });
    // a blank-after-trim fact must not be selected for embedding
    await storage
      .engine()
      .query(
        `INSERT INTO entity_facts (entity_slug, fact, confidence) VALUES ($1, '   ', 1.0)`,
        ["people/alice"],
      );
    const res = await embedFactsPhase(storage.engine(), { embed: stubEmbed });
    expect(res.scanned).toBe(1); // only the real fact, not the blank one
    expect(res.embedded).toBe(1);
  });

  it("falls open: a per-fact embed failure is collected, not thrown", async () => {
    await addFact(storage, { entity_slug: "people/alice", fact: "alpha matters" });
    const failing = (): Promise<number[]> => Promise.reject(new Error("bedrock down"));
    const res = await embedFactsPhase(storage.engine(), { embed: failing });
    expect(res.embedded).toBe(0);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]!.message).toContain("bedrock down");
    expect(await embeddingCount("people/alice")).toBe(0); // left NULL to retry
  });
});

describe("entityRecall semantic query ranking", () => {
  it("ranks facts by similarity to the query when provided", async () => {
    await addFact(storage, { entity_slug: "people/alice", fact: "beta unrelated", confidence: 1.0 });
    await addFact(storage, { entity_slug: "people/alice", fact: "alpha relevant", confidence: 0.5 });
    await embedFactsPhase(storage.engine(), { embed: stubEmbed });

    // Without a query: confidence order -> beta (1.0) first.
    const plain = await entityRecall(storage, "people/alice");
    expect(plain.facts[0]!.fact).toBe("beta unrelated");

    // With query "alpha": semantic order -> alpha fact first despite lower confidence.
    const focused = await entityRecall(storage, "people/alice", {
      query: "alpha",
      embed: stubEmbed,
    });
    expect(focused.facts[0]!.fact).toBe("alpha relevant");
  });

  it("falls open to confidence order when query embedding fails", async () => {
    await addFact(storage, { entity_slug: "people/alice", fact: "beta unrelated", confidence: 1.0 });
    await addFact(storage, { entity_slug: "people/alice", fact: "alpha relevant", confidence: 0.5 });
    await embedFactsPhase(storage.engine(), { embed: stubEmbed });
    const failing = (): Promise<number[]> => Promise.reject(new Error("bedrock down"));
    const r = await entityRecall(storage, "people/alice", { query: "alpha", embed: failing });
    expect(r.facts[0]!.fact).toBe("beta unrelated"); // reverted to confidence
  });
});
