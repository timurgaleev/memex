/**
 * Query cache integration through hybridSearch — the cache-HIT path.
 *
 * A cache hit short-circuits before any Bedrock call (embed / intent), so
 * this exercises the full wiring (key match → clock gate → hydrate → return)
 * with no AWS. We pre-seed the cache, then assert hybridSearch returns the
 * cached ranking, and that advancing the clock invalidates it.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { hybridSearch } from "../src/core/search/index.ts";
import { writeDocumentTransaction } from "../src/core/indexer-tx.ts";
import {
  putCachedQuery,
  queryCacheKey,
} from "../src/core/search/query-cache.ts";
import {
  bumpDocumentClock,
  currentDocumentClock,
} from "../src/core/generation.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-hybcache-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  // Two docs → chunks doc_a_c0, doc_b_c0. Each write bumps the clock.
  await writeDocumentTransaction(
    storage,
    { documentId: "doc_a", sourcePath: "/a.md", title: "Alpha", frontmatter: {} },
    [{ text: "alpha content", entities: [] }],
  );
  await writeDocumentTransaction(
    storage,
    { documentId: "doc_b", sourcePath: "/b.md", title: "Beta", frontmatter: {} },
    [{ text: "beta content", entities: [] }],
  );
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("hybridSearch query cache (hit path, no Bedrock)", () => {
  it("returns the cached ranking on a hit and skips retrieval", async () => {
    const clock = await currentDocumentClock(storage.engine());
    const key = queryCacheKey("my query", 5, undefined, false);
    await putCachedQuery(
      storage.engine(),
      key,
      "my query",
      5,
      "topic",
      ["doc_b_c0", "doc_a_c0"], // cached order: beta first
      clock,
    );

    // No embedText/classifyIntent mock needed: the hit short-circuits first.
    const hits = await hybridSearch(storage, "my query", { k: 5 });
    expect(hits.map((h) => h.chunkId)).toEqual(["doc_b_c0", "doc_a_c0"]);
    expect(hits[0]!.title).toBe("Beta"); // hydrated from live tables
    expect(hits[0]!.intent).toBe("topic");
  });

  it("invalidates the entry hybridSearch would read once the clock advances", async () => {
    const clock = await currentDocumentClock(storage.engine());
    const key = queryCacheKey("stale q", 5, undefined, false);
    await putCachedQuery(storage.engine(), key, "stale q", 5, "topic", ["doc_a_c0"], clock);
    // A new document write bumps the clock → the cached row is now stale.
    await storage.engine().transaction((tx) => bumpDocumentClock(tx));
    const newClock = await currentDocumentClock(storage.engine());
    // hybridSearch reads getCachedQuery(key, currentClock): at the new clock
    // the seeded entry no longer matches, so the cache-hit path is skipped.
    const { getCachedQuery } = await import("../src/core/search/query-cache.ts");
    expect(await getCachedQuery(storage.engine(), key, newClock)).toBeNull();
    expect(await getCachedQuery(storage.engine(), key, clock)).not.toBeNull();
  });
});
