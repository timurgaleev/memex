/**
 * Query-cache operator surface — cacheStats / pruneCache / clearCache.
 * Seeds rows at two clock values and asserts fresh/stale accounting and the
 * two deletion paths against a fresh PGLite brain (migration 026).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import {
  putCachedQuery,
  cacheStats,
  pruneCache,
  clearCache,
} from "../src/core/search/query-cache.ts";

const dir = mkdtempSync(join(tmpdir(), "memex-cache-cli-"));
let storage: Storage;

const FRESH = 5; // pretend the current document clock is 5
const STALE = 4;

// Align the live document clock so putCachedQuery's race guard (only persist
// when the live clock equals the stamped clock) admits each seeded row.
async function setClock(n: number): Promise<void> {
  await storage
    .engine()
    .query("UPDATE document_generation_clock SET value = $1 WHERE id = 1", [n]);
}

beforeAll(async () => {
  storage = new Storage({ dbPath: join(dir, "db") });
  await storage.init();
  const e = storage.engine();
  // Seed the stale row first, as if stored when the clock was 4 …
  await setClock(STALE);
  await putCachedQuery(e, "k3", "gamma", 10, "factual", ["c3"], STALE);
  // … then advance the clock to 5 and store the two fresh rows.
  await setClock(FRESH);
  await putCachedQuery(e, "k1", "alpha", 10, "factual", ["c1"], FRESH);
  await putCachedQuery(e, "k2", "beta", 10, "topic", ["c2"], FRESH);
});

afterAll(async () => {
  await storage.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("cacheStats", () => {
  it("splits fresh vs stale against the current clock", async () => {
    const s = await cacheStats(storage.engine(), FRESH);
    expect(s.total).toBe(3);
    expect(s.fresh).toBe(2);
    expect(s.stale).toBe(1);
    expect(s.current_clock).toBe(FRESH);
    expect(s.distinct_intents).toBe(2); // factual, topic
    expect(s.oldest_created_at).not.toBeNull();
  });
});

describe("pruneCache", () => {
  it("removes only the stale rows, leaving fresh intact", async () => {
    const removed = await pruneCache(storage.engine(), FRESH);
    expect(removed).toBe(1);
    const s = await cacheStats(storage.engine(), FRESH);
    expect(s.total).toBe(2);
    expect(s.stale).toBe(0);
  });
});

describe("clearCache", () => {
  it("removes every remaining row", async () => {
    const removed = await clearCache(storage.engine());
    expect(removed).toBe(2);
    const s = await cacheStats(storage.engine(), FRESH);
    expect(s.total).toBe(0);
    expect(s.oldest_created_at).toBeNull();
  });
});
