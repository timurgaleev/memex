/**
 * Two-layer query-cache invalidation (migration 031).
 *
 * Layer 1 = global document_generation_clock bookmark (exact match).
 * Layer 2 = per-document generation snapshot: when the clock advanced, a row
 * still serves iff every referenced document still exists with an unchanged
 * `generation`. So a write to an UNRELATED document no longer evicts a cached
 * query, while a write to a REFERENCED document (or its deletion) does.
 *
 * Fresh PGLite Storage per test; no Bedrock. Documents are written via the
 * real indexer transaction (which bumps both the global clock and the touched
 * document's generation), so these exercise the production write path.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { writeDocumentTransaction } from "../src/core/indexer-tx.ts";
import { currentDocumentClock } from "../src/core/generation.ts";
import { frontmatterInferencePhase } from "../src/core/cycle/frontmatter-inference.ts";
import { backfillDocumentSources, registerSource } from "../src/core/sources.ts";
import {
  cacheStats,
  getCachedQuery,
  pruneCache,
  putCachedQuery,
  queryCacheKey,
  validateCacheRow,
} from "../src/core/search/query-cache.ts";

let tmp: string;
let storage: Storage;

async function docGeneration(id: string): Promise<number | undefined> {
  const r = await storage
    .engine()
    .query<{ generation: number }>(
      "SELECT generation FROM documents WHERE id = $1",
      [id],
    );
  const g = r.rows[0]?.generation;
  return g === undefined ? undefined : Number(g);
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-2lc-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  // Two independent docs. Each write bumps the global clock + that doc's gen.
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

describe("validateCacheRow (pure two-layer gate)", () => {
  const snap = { clockValue: 10, docGenerations: { doc_a: 3, doc_b: 1 } };

  it("Layer 1: matching clock serves regardless of doc state", () => {
    expect(
      validateCacheRow(snap, { clock: 10, docGenerations: {} }),
    ).toBe(true);
  });

  it("Layer 2: clock advanced but all referenced docs unchanged → serves", () => {
    expect(
      validateCacheRow(snap, {
        clock: 11,
        docGenerations: { doc_a: 3, doc_b: 1 },
      }),
    ).toBe(true);
  });

  it("Layer 2: a referenced doc bumped → invalidates", () => {
    expect(
      validateCacheRow(snap, {
        clock: 11,
        docGenerations: { doc_a: 4, doc_b: 1 },
      }),
    ).toBe(false);
  });

  it("Layer 2: a referenced doc deleted → invalidates", () => {
    expect(
      validateCacheRow(snap, {
        clock: 11,
        docGenerations: { doc_a: undefined, doc_b: 1 },
      }),
    ).toBe(false);
  });

  it("empty snapshot behind an advanced clock → invalidates (Layer 1 only)", () => {
    expect(
      validateCacheRow(
        { clockValue: 10, docGenerations: {} },
        { clock: 11, docGenerations: {} },
      ),
    ).toBe(false);
  });
});

describe("two-layer gate through the database", () => {
  it("stores the referenced docs' generations in the snapshot", async () => {
    const clock = await currentDocumentClock(storage.engine());
    const genA = await docGeneration("doc_a");
    const key = queryCacheKey("q", 5, undefined, false);
    await putCachedQuery(
      storage.engine(),
      key,
      "q",
      5,
      "topic",
      ["doc_a_c0"],
      clock,
      ["doc_a"],
    );
    const row = await storage
      .engine()
      .query<{ doc_generations: Record<string, number> }>(
        "SELECT doc_generations FROM query_cache WHERE cache_key = $1",
        [key],
      );
    expect(row.rows[0]!.doc_generations).toEqual({ doc_a: genA! });
  });

  it("a write to an UNRELATED doc keeps the cached row servable (Layer 2)", async () => {
    const clock = await currentDocumentClock(storage.engine());
    const key = queryCacheKey("about a", 5, undefined, false);
    await putCachedQuery(
      storage.engine(),
      key,
      "about a",
      5,
      "topic",
      ["doc_a_c0"],
      clock,
      ["doc_a"],
    );

    // Re-index doc_b: global clock advances, doc_a's generation is untouched.
    await writeDocumentTransaction(
      storage,
      { documentId: "doc_b", sourcePath: "/b.md", title: "Beta", frontmatter: {} },
      [{ text: "beta content edited", entities: [] }],
    );
    const newClock = await currentDocumentClock(storage.engine());
    expect(newClock).toBeGreaterThan(clock);

    // Layer 1 fails (clock moved) but Layer 2 holds → still a hit.
    const hit = await getCachedQuery(storage.engine(), key, newClock);
    expect(hit).not.toBeNull();
    expect(hit!.resultIds).toEqual(["doc_a_c0"]);
  });

  it("a write to a REFERENCED doc invalidates the cached row (Layer 2)", async () => {
    const clock = await currentDocumentClock(storage.engine());
    const key = queryCacheKey("about a", 5, undefined, false);
    await putCachedQuery(
      storage.engine(),
      key,
      "about a",
      5,
      "topic",
      ["doc_a_c0"],
      clock,
      ["doc_a"],
    );

    // Re-index doc_a itself → its generation bumps → Layer 2 mismatch.
    await writeDocumentTransaction(
      storage,
      { documentId: "doc_a", sourcePath: "/a.md", title: "Alpha", frontmatter: {} },
      [{ text: "alpha content edited", entities: [] }],
    );
    const newClock = await currentDocumentClock(storage.engine());
    expect(await getCachedQuery(storage.engine(), key, newClock)).toBeNull();
  });

  it("a deleted referenced doc invalidates the cached row (Layer 2)", async () => {
    const clock = await currentDocumentClock(storage.engine());
    const key = queryCacheKey("about a", 5, undefined, false);
    await putCachedQuery(
      storage.engine(),
      key,
      "about a",
      5,
      "topic",
      ["doc_a_c0"],
      clock,
      ["doc_a"],
    );
    // Hard-delete doc_a (no such path in prod today, but Layer 2 must handle it)
    // and bump the clock so Layer 1 fails and we fall through to Layer 2.
    await storage.engine().transaction(async (tx) => {
      await tx.query("DELETE FROM documents WHERE id = $1", ["doc_a"]);
      const { bumpDocumentClock } = await import("../src/core/generation.ts");
      await bumpDocumentClock(tx);
    });
    const newClock = await currentDocumentClock(storage.engine());
    expect(await getCachedQuery(storage.engine(), key, newClock)).toBeNull();
  });

  it("empty snapshot (no documentIds) relies on Layer 1 exclusively", async () => {
    const clock = await currentDocumentClock(storage.engine());
    const key = queryCacheKey("empty", 5, undefined, false);
    await putCachedQuery(
      storage.engine(),
      key,
      "empty",
      5,
      "topic",
      ["doc_a_c0"],
      clock,
      [], // no snapshot
    );
    // Same clock → Layer 1 hit.
    expect(await getCachedQuery(storage.engine(), key, clock)).not.toBeNull();
    // Any clock advance → empty snapshot cannot save it.
    expect(await getCachedQuery(storage.engine(), key, clock + 1)).toBeNull();
  });
});

describe("prune + stats are two-layer aware", () => {
  it("prune keeps Layer-2-fresh rows and drops only doubly-stale ones", async () => {
    const clock = await currentDocumentClock(storage.engine());
    // Row R1 references doc_a; row R2 has an empty snapshot.
    const k1 = queryCacheKey("refs a", 5, undefined, false);
    const k2 = queryCacheKey("refs none", 5, undefined, false);
    await putCachedQuery(storage.engine(), k1, "refs a", 5, "topic", ["doc_a_c0"], clock, ["doc_a"]);
    await putCachedQuery(storage.engine(), k2, "refs none", 5, "topic", ["doc_a_c0"], clock, []);

    // Re-index doc_b → clock advances; doc_a untouched.
    await writeDocumentTransaction(
      storage,
      { documentId: "doc_b", sourcePath: "/b.md", title: "Beta", frontmatter: {} },
      [{ text: "beta edited", entities: [] }],
    );
    const newClock = await currentDocumentClock(storage.engine());

    const stats = await cacheStats(storage.engine(), newClock);
    expect(stats.total).toBe(2);
    expect(stats.fresh).toBe(1); // R1 survives via Layer 2
    expect(stats.stale).toBe(1); // R2 empty-snapshot is doubly stale

    const removed = await pruneCache(storage.engine(), newClock);
    expect(removed).toBe(1); // only R2 dropped
    expect(await getCachedQuery(storage.engine(), k1, newClock)).not.toBeNull();
    expect(await getCachedQuery(storage.engine(), k2, newClock)).toBeNull();
  });
});

// Every writer that changes a ranking-relevant field of a document must bump
// that doc's generation + the global clock, or Layer 2 would keep serving a
// cached ranking that returned the now-changed doc. These lock the two writers
// the review surfaced (frontmatter inference → salience; source assignment →
// source-boost + scope).
describe("non-indexer document writers invalidate the two-layer cache", () => {
  it("frontmatter inference bumps generation + clock → cached row invalidates", async () => {
    const clock = await currentDocumentClock(storage.engine());
    const genBefore = await docGeneration("doc_a");
    const key = queryCacheKey("about a", 5, undefined, false);
    await putCachedQuery(
      storage.engine(),
      key,
      "about a",
      5,
      "topic",
      ["doc_a_c0"],
      clock,
      ["doc_a"],
    );
    expect(await getCachedQuery(storage.engine(), key, clock)).not.toBeNull();

    // doc_a has title "Alpha" but empty frontmatter → inference fills it in.
    const r = await frontmatterInferencePhase(storage.engine());
    expect(r.updated).toBeGreaterThan(0);

    expect(await docGeneration("doc_a")).toBeGreaterThan(genBefore!);
    const newClock = await currentDocumentClock(storage.engine());
    expect(newClock).toBeGreaterThan(clock);
    // Layer 1 fails (clock moved) AND Layer 2 fails (doc_a generation bumped).
    expect(await getCachedQuery(storage.engine(), key, newClock)).toBeNull();
  });

  it("source backfill bumps generation + clock → cached row invalidates", async () => {
    await registerSource(storage.engine(), {
      id: "src_a",
      kind: "vault",
      pathPrefix: "/a",
    });
    const clock = await currentDocumentClock(storage.engine());
    const genBefore = await docGeneration("doc_a");
    const key = queryCacheKey("scoped a", 5, undefined, false);
    await putCachedQuery(
      storage.engine(),
      key,
      "scoped a",
      5,
      "topic",
      ["doc_a_c0"],
      clock,
      ["doc_a"],
    );
    expect(await getCachedQuery(storage.engine(), key, clock)).not.toBeNull();

    // doc_a's source_path "/a.md" matches the "/a" prefix → source_id assigned.
    const res = await backfillDocumentSources(storage.engine());
    expect(res.updated).toBeGreaterThan(0);

    expect(await docGeneration("doc_a")).toBeGreaterThan(genBefore!);
    const newClock = await currentDocumentClock(storage.engine());
    expect(await getCachedQuery(storage.engine(), key, newClock)).toBeNull();
  });
});
