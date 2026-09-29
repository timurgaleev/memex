/**
 * Semantic (embedding-cosine) query-cache arm (migration 065). On an exact-match
 * miss the cache matches the nearest stored query embedding within the same
 * scope/knobs bucket, cosine >= threshold, TTL- and freshness-gated. The exact
 * arm and memex's stronger freshness model (generation clock + per-doc snapshot)
 * are unchanged — this only ADDS the semantic-hit path.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { currentDocumentClock, bumpDocumentClock } from "../src/core/generation.ts";
import {
  putCachedQuery,
  getSemanticCachedQuery,
  queryCacheBucketKey,
  resolveSemanticCacheConfig,
  DEFAULT_SEMANTIC_SIMILARITY,
  DEFAULT_SEMANTIC_TTL_SECONDS,
} from "../src/core/search/query-cache.ts";

/** A unit 1024-vector with mass on the first two dims (a^2 + b^2 must be 1). */
function unit(a: number, b: number): number[] {
  const v = new Array(1024).fill(0);
  v[0] = a;
  v[1] = b;
  return v;
}

const BASE = unit(1, 0);
const NEAR = unit(0.95, Math.sqrt(1 - 0.95 ** 2)); // cosine 0.95 vs BASE → hit
const BORDER = unit(0.9, Math.sqrt(1 - 0.9 ** 2)); // cosine 0.90 vs BASE → miss @0.92
const FAR = unit(0, 1); // orthogonal → cosine 0 → miss

const CFG = { similarity: 0.92, ttlSeconds: 3600 };

let tmp: string;
let storage: Storage;

async function seed(
  key: string,
  bucketKey: string,
  embedding: number[],
  clock: number,
): Promise<void> {
  await putCachedQuery(
    storage.engine(),
    key,
    "some query text",
    5,
    "topic",
    ["c1", "c2"],
    clock,
    [], // empty snapshot → Layer 1 (clock) only
    { bucketKey, queryEmbedding: embedding },
  );
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-semcache-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("getSemanticCachedQuery", () => {
  it("returns a hit for a paraphrase within the cosine threshold", async () => {
    const clock = await currentDocumentClock(storage.engine());
    const bucket = queryCacheBucketKey(5, undefined, false);
    await seed("k1", bucket, BASE, clock);

    const hit = await getSemanticCachedQuery(storage.engine(), bucket, NEAR, clock, CFG);
    expect(hit).not.toBeNull();
    expect(hit!.resultIds).toEqual(["c1", "c2"]);
    expect(hit!.intent).toBe("topic");
    expect(hit!.similarity).toBeGreaterThanOrEqual(0.92);
  });

  it("misses when the nearest stored query is below the threshold", async () => {
    const clock = await currentDocumentClock(storage.engine());
    const bucket = queryCacheBucketKey(5, undefined, false);
    await seed("k1", bucket, BASE, clock);

    expect(await getSemanticCachedQuery(storage.engine(), bucket, BORDER, clock, CFG)).toBeNull();
    expect(await getSemanticCachedQuery(storage.engine(), bucket, FAR, clock, CFG)).toBeNull();
  });

  it("is confined to the same scope/knobs bucket", async () => {
    const clock = await currentDocumentClock(storage.engine());
    const bucketA = queryCacheBucketKey(5, ["src-a"], false);
    const bucketB = queryCacheBucketKey(5, ["src-b"], false);
    await seed("k1", bucketA, BASE, clock);

    // Same near vector, wrong bucket → no cross-scope borrow.
    expect(await getSemanticCachedQuery(storage.engine(), bucketB, NEAR, clock, CFG)).toBeNull();
    expect(await getSemanticCachedQuery(storage.engine(), bucketA, NEAR, clock, CFG)).not.toBeNull();
  });

  it("is TTL-bounded: an entry older than the TTL is not served", async () => {
    const clock = await currentDocumentClock(storage.engine());
    const bucket = queryCacheBucketKey(5, undefined, false);
    await seed("k1", bucket, BASE, clock);
    // Backdate the row 10s.
    await storage
      .engine()
      .query("UPDATE query_cache SET created_at = NOW() - INTERVAL '10 seconds' WHERE cache_key = 'k1'");

    expect(
      await getSemanticCachedQuery(storage.engine(), bucket, NEAR, clock, { similarity: 0.92, ttlSeconds: 5 }),
    ).toBeNull(); // 10s > 5s TTL
    expect(
      await getSemanticCachedQuery(storage.engine(), bucket, NEAR, clock, { similarity: 0.92, ttlSeconds: 3600 }),
    ).not.toBeNull(); // within 1h TTL
  });

  it("re-applies the two-layer freshness gate: a stale clock with an empty snapshot misses", async () => {
    const clock = await currentDocumentClock(storage.engine());
    const bucket = queryCacheBucketKey(5, undefined, false);
    await seed("k1", bucket, BASE, clock);
    expect(await getSemanticCachedQuery(storage.engine(), bucket, NEAR, clock, CFG)).not.toBeNull();

    // A write advances the clock; the row's empty snapshot cannot pass Layer 2.
    await bumpDocumentClock(storage.engine());
    const newClock = await currentDocumentClock(storage.engine());
    expect(newClock).toBeGreaterThan(clock);
    expect(await getSemanticCachedQuery(storage.engine(), bucket, NEAR, newClock, CFG)).toBeNull();
  });

  it("never matches a row stored without an embedding (exact-only rows)", async () => {
    const clock = await currentDocumentClock(storage.engine());
    const bucket = queryCacheBucketKey(5, undefined, false);
    // No semantic arg → query_embedding stays NULL.
    await putCachedQuery(
      storage.engine(),
      "k-exact",
      "q",
      5,
      "topic",
      ["c1"],
      clock,
      [],
    );
    expect(await getSemanticCachedQuery(storage.engine(), bucket, BASE, clock, CFG)).toBeNull();
  });
});

describe("queryCacheBucketKey", () => {
  it("is independent of the query text but sensitive to knobs", () => {
    const a = queryCacheBucketKey(5, ["s1"], false, "sig");
    const b = queryCacheBucketKey(5, ["s1"], false, "sig");
    expect(a).toBe(b); // deterministic, query text not an input
    expect(queryCacheBucketKey(10, ["s1"], false, "sig")).not.toBe(a); // k
    expect(queryCacheBucketKey(5, ["s2"], false, "sig")).not.toBe(a); // scope
    expect(queryCacheBucketKey(5, ["s1"], true, "sig")).not.toBe(a); // rerank
    expect(queryCacheBucketKey(5, ["s1"], false, "sig2")).not.toBe(a); // ranking sig
  });

  it("normalizes scope order + case like the exact key", () => {
    expect(queryCacheBucketKey(5, ["B", "a"], false, "s")).toBe(
      queryCacheBucketKey(5, ["a", "b"], false, "s"),
    );
  });
});

describe("resolveSemanticCacheConfig", () => {
  it("defaults to OFF with the documented thresholds", () => {
    const c = resolveSemanticCacheConfig({});
    expect(c.enabled).toBe(false);
    expect(c.similarity).toBe(DEFAULT_SEMANTIC_SIMILARITY);
    expect(c.ttlSeconds).toBe(DEFAULT_SEMANTIC_TTL_SECONDS);
  });

  it("reads the env flags and clamps garbage to defaults", () => {
    expect(resolveSemanticCacheConfig({ MEMEX_QUERY_CACHE_SEMANTIC: "1" }).enabled).toBe(true);
    expect(
      resolveSemanticCacheConfig({ MEMEX_QUERY_CACHE_SIM: "0.8" }).similarity,
    ).toBe(0.8);
    expect(
      resolveSemanticCacheConfig({ MEMEX_QUERY_CACHE_SIM: "1.5" }).similarity,
    ).toBe(DEFAULT_SEMANTIC_SIMILARITY); // out of (0,1] → default
    expect(
      resolveSemanticCacheConfig({ MEMEX_QUERY_CACHE_SIM: "nope" }).similarity,
    ).toBe(DEFAULT_SEMANTIC_SIMILARITY);
    expect(resolveSemanticCacheConfig({ MEMEX_QUERY_CACHE_TTL: "60" }).ttlSeconds).toBe(60);
    expect(resolveSemanticCacheConfig({ MEMEX_QUERY_CACHE_TTL: "-5" }).ttlSeconds).toBe(
      DEFAULT_SEMANTIC_TTL_SECONDS,
    );
  });
});
