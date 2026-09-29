/**
 * Query cache (migration 026) — key determinism + clock-gated get/put.
 * Fresh PGLite Storage per test; no Bedrock.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import {
  getCachedQuery,
  putCachedQuery,
  queryCacheKey,
} from "../src/core/search/query-cache.ts";

let tmp: string;
let storage: Storage;

/**
 * Set the live document_generation_clock. putCachedQuery only persists a row
 * when the live clock equals the stamped clock (the mid-search race guard), so
 * these unit tests align the live clock with the synthetic stamp they use.
 */
async function setClock(n: number): Promise<void> {
  await storage
    .engine()
    .query("UPDATE document_generation_clock SET value = $1 WHERE id = 1", [n]);
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-qcache-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});
afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("queryCacheKey", () => {
  it("is stable across whitespace/case and order-independent on sources", () => {
    const a = queryCacheKey("Hello  World", 5, ["s2", "s1"], false);
    const b = queryCacheKey("hello world", 5, ["s1", "s2"], false);
    expect(a).toBe(b);
  });

  it("differs on k and on the rerank knob", () => {
    const base = queryCacheKey("q", 5, undefined, false);
    expect(queryCacheKey("q", 10, undefined, false)).not.toBe(base);
    expect(queryCacheKey("q", 5, undefined, true)).not.toBe(base);
  });
});

describe("get/put with clock gating", () => {
  it("returns null on miss", async () => {
    const r = await getCachedQuery(storage.engine(), "nope", 1);
    expect(r).toBeNull();
  });

  it("round-trips a ranking at the matching clock", async () => {
    await setClock(7);
    const key = queryCacheKey("q", 5, undefined, false);
    await putCachedQuery(storage.engine(), key, "q", 5, "topic", ["c1", "c2"], 7);
    const hit = await getCachedQuery(storage.engine(), key, 7);
    expect(hit).not.toBeNull();
    expect(hit!.intent).toBe("topic");
    expect(hit!.resultIds).toEqual(["c1", "c2"]);
  });

  it("is invalidated when the clock advances", async () => {
    await setClock(7);
    const key = queryCacheKey("q", 5, undefined, false);
    await putCachedQuery(storage.engine(), key, "q", 5, "topic", ["c1"], 7);
    expect(await getCachedQuery(storage.engine(), key, 8)).toBeNull(); // clock moved
    expect(await getCachedQuery(storage.engine(), key, 7)).not.toBeNull(); // old clock still hits
  });

  it("upserts (newest write wins) on the same key", async () => {
    const key = queryCacheKey("q", 5, undefined, false);
    await setClock(7);
    await putCachedQuery(storage.engine(), key, "q", 5, "topic", ["c1"], 7);
    await setClock(9);
    await putCachedQuery(storage.engine(), key, "q", 5, "factual", ["c9", "c8"], 9);
    const hit = await getCachedQuery(storage.engine(), key, 9);
    expect(hit!.intent).toBe("factual");
    expect(hit!.resultIds).toEqual(["c9", "c8"]);
    expect(await getCachedQuery(storage.engine(), key, 7)).toBeNull(); // old clock gone
  });

  it("does NOT persist a row when the live clock advanced mid-search (race guard)", async () => {
    await setClock(5);
    const key = queryCacheKey("q", 5, undefined, false);
    // Caller read clockValue=4 before ranking, but a write moved the live clock
    // to 5 before this put → the ranking is against a stale corpus, so nothing
    // is cached (the snapshot must never be stamped at a clock it doesn't match).
    await putCachedQuery(storage.engine(), key, "q", 5, "topic", ["c1"], 4);
    expect(await getCachedQuery(storage.engine(), key, 4)).toBeNull();
    expect(await getCachedQuery(storage.engine(), key, 5)).toBeNull();
  });
});
