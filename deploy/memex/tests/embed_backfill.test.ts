/**
 * Embedding backfill (`memex embed`) — re-embed non-code chunks missing a
 * vector, the operator remedy for partial vector-arm coverage.
 *
 * Seeds: a code document (frontmatter kind:code, no embedding — graph-only by
 * design), a markdown document with two un-embedded chunks, and a markdown
 * document already carrying an embedding. The backfill must target ONLY the
 * two un-embedded markdown chunks, never the code chunk and never the
 * already-embedded one, and must be idempotent.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { writeDocumentTransaction } from "../src/core/indexer-tx.ts";
import { runEmbedBackfill } from "../src/core/embed-backfill.ts";
import { currentDocumentClock } from "../src/core/generation.ts";
import {
  buildContextualPrefix,
  wrapChunkForEmbedding,
  extractFirstTwoSentences,
} from "../src/core/search/contextual-embed.ts";
import { deterministicEmbed } from "./det-embed.ts";

const detEmbed = (t: string) => Promise.resolve(deterministicEmbed(t));

let tmp: string;
let storage: Storage;

async function embeddingCount(): Promise<number> {
  const r = await storage
    .engine()
    .query<{ n: number }>("SELECT COUNT(*)::int AS n FROM embeddings");
  return r.rows[0]?.n ?? 0;
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-embed-backfill-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();

  // Code document — graph-only, frontmatter kind:code, chunk carries NO embedding.
  await writeDocumentTransaction(
    storage,
    {
      documentId: "doc_code",
      sourcePath: "/src/x.ts",
      title: "x.ts",
      frontmatter: { kind: "code", language: "typescript" },
      embeddingModel: "det",
    },
    [{ text: "function alpha() { return betaHelper(); }", entities: [], symbolName: "alpha" }],
  );

  // Markdown document — two chunks, NO embeddings (the backfill targets).
  await writeDocumentTransaction(
    storage,
    { documentId: "doc_md_missing", sourcePath: "/notes/a.md", title: "a", frontmatter: {}, embeddingModel: "det" },
    [
      { text: "first markdown chunk about retrieval quality", entities: [] },
      { text: "second markdown chunk about vector search", entities: [] },
    ],
  );

  // Markdown document — already embedded (must stay untouched, never a candidate).
  await writeDocumentTransaction(
    storage,
    { documentId: "doc_md_done", sourcePath: "/notes/b.md", title: "b", frontmatter: {}, embeddingModel: "det" },
    [{ text: "already embedded markdown chunk", entities: [], embedding: deterministicEmbed("already embedded markdown chunk") }],
  );

  // Markdown document marked embed_skip — un-embedded chunks that the backfill
  // must NEVER target (indexed + keyword-searchable, but excluded from the
  // vector arm by design).
  await writeDocumentTransaction(
    storage,
    { documentId: "doc_md_skip", sourcePath: "/notes/c.md", title: "c", frontmatter: { embed_skip: true }, embeddingModel: "det" },
    [
      { text: "skipped chunk about retrieval quality", entities: [] },
      { text: "another skipped chunk about vector search", entities: [] },
    ],
  );
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("embed backfill", () => {
  it("dry-run counts the missing non-code chunks and writes nothing", async () => {
    const before = await embeddingCount();
    const r = await runEmbedBackfill(storage.engine(), { dryRun: true, embed: detEmbed });
    expect(r.candidates).toBe(2);
    expect(r.embedded).toBe(0);
    expect(r.dryRun).toBe(true);
    expect(await embeddingCount()).toBe(before); // no writes
  });

  it("embeds exactly the two missing markdown chunks (code + already-embedded excluded)", async () => {
    const r = await runEmbedBackfill(storage.engine(), { embed: detEmbed });
    expect(r.candidates).toBe(2);
    expect(r.embedded).toBe(2);
    expect(r.failed).toBe(0);

    // The code chunk must NOT have gained an embedding.
    const codeEmb = await storage
      .engine()
      .query<{ n: number }>("SELECT COUNT(*)::int AS n FROM embeddings WHERE chunk_id = $1", ["doc_code_c0"]);
    expect(codeEmb.rows[0]?.n).toBe(0);

    // Total: 1 (pre-existing) + 2 (backfilled) = 3.
    expect(await embeddingCount()).toBe(3);
  });

  it("never targets an embed_skip document's un-embedded chunks", async () => {
    const r = await runEmbedBackfill(storage.engine(), { embed: detEmbed });
    // Only the two doc_md_missing chunks — the embed_skip pair is excluded.
    expect(r.candidates).toBe(2);
    const skipEmb = await storage
      .engine()
      .query<{ n: number }>("SELECT COUNT(*)::int AS n FROM embeddings WHERE chunk_id LIKE 'doc_md_skip%'");
    expect(skipEmb.rows[0]?.n).toBe(0);
  });

  it("is idempotent — a second run finds nothing left", async () => {
    await runEmbedBackfill(storage.engine(), { embed: detEmbed });
    const second = await runEmbedBackfill(storage.engine(), { embed: detEmbed });
    expect(second.candidates).toBe(0);
    expect(second.embedded).toBe(0);
  });

  it("respects --limit", async () => {
    const r = await runEmbedBackfill(storage.engine(), { limit: 1, embed: detEmbed });
    expect(r.candidates).toBe(1);
    expect(r.embedded).toBe(1);
    // The other chunk remains a candidate on the next run.
    const next = await runEmbedBackfill(storage.engine(), { dryRun: true, embed: detEmbed });
    expect(next.candidates).toBe(1);
  });

  it("bumps the document-generation clock after embedding (invalidates the query cache)", async () => {
    const before = await currentDocumentClock(storage.engine());
    const r = await runEmbedBackfill(storage.engine(), { embed: detEmbed });
    expect(r.embedded).toBe(2);
    const after = await currentDocumentClock(storage.engine());
    expect(after).toBeGreaterThan(before);
  });

  it("clears the query cache after embedding — Layer 2 cannot cover a re-embed", async () => {
    // Seed a cache row whose Layer 2 snapshot references a doc that the
    // backfill does NOT re-write (so its generation is unchanged). Under the
    // two-layer gate that row would survive a bare clock bump and serve a
    // ranking blind to the freshly-embedded chunks — backfill must clearCache.
    const { putCachedQuery, getCachedQuery, queryCacheKey } = await import(
      "../src/core/search/query-cache.ts"
    );
    const clock = await currentDocumentClock(storage.engine());
    const key = queryCacheKey("seed q", 5, undefined, false);
    await putCachedQuery(
      storage.engine(),
      key,
      "seed q",
      5,
      "topic",
      ["doc_md_done_c0"],
      clock,
      ["doc_md_done"], // unchanged by the backfill → Layer 2 would keep it
    );
    expect(await getCachedQuery(storage.engine(), key, clock)).not.toBeNull();

    const r = await runEmbedBackfill(storage.engine(), { embed: detEmbed });
    expect(r.embedded).toBe(2);

    // Cleared outright — gone at the OLD clock AND the new one.
    const after = await currentDocumentClock(storage.engine());
    expect(await getCachedQuery(storage.engine(), key, clock)).toBeNull();
    expect(await getCachedQuery(storage.engine(), key, after)).toBeNull();
  });

  it("does NOT bump the clock on a dry-run or when nothing is embedded", async () => {
    const c0 = await currentDocumentClock(storage.engine());
    await runEmbedBackfill(storage.engine(), { dryRun: true, embed: detEmbed });
    expect(await currentDocumentClock(storage.engine())).toBe(c0);

    // Embed everything, then a second real run has no candidates → no bump.
    await runEmbedBackfill(storage.engine(), { embed: detEmbed });
    const c1 = await currentDocumentClock(storage.engine());
    await runEmbedBackfill(storage.engine(), { embed: detEmbed });
    expect(await currentDocumentClock(storage.engine())).toBe(c1);
  });

  it("pages through candidates in keyset batches, not a single in-memory load", async () => {
    const engine = storage.engine();
    let pageFetches = 0;
    const origQuery = engine.query.bind(engine);
    // Count only candidate PAGE fetches (the `SELECT c.id, c.content` walk),
    // never the count query or the inserts.
    (engine as unknown as { query: typeof engine.query }).query = ((
      sql: string,
      params?: unknown[],
    ) => {
      if (sql.includes("SELECT c.id, c.content") && sql.includes("em.chunk_id IS NULL")) {
        pageFetches++;
      }
      return origQuery(sql, params);
    }) as typeof engine.query;

    const r = await runEmbedBackfill(engine, { embed: detEmbed, pageSize: 1 });
    (engine as unknown as { query: typeof engine.query }).query = origQuery;

    expect(r.embedded).toBe(2);
    // pageSize 1 over 2 candidates: two full pages of one, then a third fetch
    // that returns zero and terminates — three round-trips, never one big load.
    expect(pageFetches).toBe(3);
  });

  it("startAfterId excludes ids at or before the cursor (keyset resume)", async () => {
    const r = await runEmbedBackfill(storage.engine(), {
      embed: detEmbed,
      startAfterId: "doc_md_missing_c0",
    });
    // Only the chunk after the cursor is a candidate.
    expect(r.candidates).toBe(1);
    expect(r.embedded).toBe(1);
    expect(r.lastId).toBe("doc_md_missing_c1");
    // The cursor-skipped chunk stays un-embedded.
    const c0 = await storage
      .engine()
      .query<{ n: number }>(
        "SELECT COUNT(*)::int AS n FROM embeddings WHERE chunk_id = $1",
        ["doc_md_missing_c0"],
      );
    expect(c0.rows[0]?.n).toBe(0);
  });

  it("resumes from a prior run's lastId and never double-embeds", async () => {
    // First pass caps at one chunk and reports the cursor it stopped at.
    const first = await runEmbedBackfill(storage.engine(), { embed: detEmbed, limit: 1 });
    expect(first.embedded).toBe(1);
    expect(first.lastId).not.toBeNull();

    // Resume from that cursor: the remaining chunk embeds, nothing repeats.
    const resumed = await runEmbedBackfill(storage.engine(), {
      embed: detEmbed,
      startAfterId: first.lastId!,
    });
    expect(resumed.candidates).toBe(1);
    expect(resumed.embedded).toBe(1);
    // 1 seed + 2 backfilled, none doubled.
    expect(await embeddingCount()).toBe(3);
  });

  it("terminates cleanly at the end of the candidate set", async () => {
    const r = await runEmbedBackfill(storage.engine(), { embed: detEmbed, pageSize: 1 });
    expect(r.embedded).toBe(2);
    expect(r.lastId).toBe("doc_md_missing_c1");
    // A resume from the final cursor finds zero and stops without work.
    const after = await runEmbedBackfill(storage.engine(), {
      embed: detEmbed,
      startAfterId: r.lastId!,
    });
    expect(after.candidates).toBe(0);
    expect(after.embedded).toBe(0);
    expect(after.lastId).toBeNull();
  });

  it("re-embeds a contextual_embedded chunk with the wrapped text, unmarked chunks raw", async () => {
    // A document whose vectors were built under the contextual prefix, then
    // lost (dimension migration / transient failure): chunks are marked but
    // have no embeddings row. The backfill must hand the embedder the SAME
    // wrapped text `reindex --contextual` builds, never the raw content.
    const opening = "Ctx synopsis one. Ctx synopsis two. Rest of the opening chunk.";
    const second = "second contextual chunk about ranking";
    await writeDocumentTransaction(
      storage,
      { documentId: "doc_ctx", sourcePath: "/notes/ctx.md", title: "Ctx Doc", frontmatter: {}, embeddingModel: "det" },
      [
        { text: opening, entities: [] },
        { text: second, entities: [] },
      ],
    );
    await storage
      .engine()
      .query("UPDATE chunks SET contextual_embedded = TRUE WHERE document_id = $1", ["doc_ctx"]);

    const seen: string[] = [];
    const capture = (t: string) => {
      seen.push(t);
      return Promise.resolve(deterministicEmbed(t));
    };
    const r = await runEmbedBackfill(storage.engine(), { embed: capture });
    // 2 doc_md_missing (unmarked) + 2 doc_ctx (marked).
    expect(r.embedded).toBe(4);

    const prefix = buildContextualPrefix("Ctx Doc", extractFirstTwoSentences(opening), { isCode: false });
    expect(seen).toContain(wrapChunkForEmbedding(opening, prefix, { isCode: false }));
    expect(seen).toContain(wrapChunkForEmbedding(second, prefix, { isCode: false }));
    // The unmarked chunks embed their raw content — no prefix leaks onto them.
    expect(seen).toContain("first markdown chunk about retrieval quality");
    expect(seen).toContain("second markdown chunk about vector search");
    expect(seen.some((t) => t.includes("<context>first markdown"))).toBe(false);
  });

  it("forceReembed keeps the contextual marker truthful — the replacement vector is wrapped", async () => {
    const text = "forced contextual chunk body. It has a synopsis sentence.";
    await writeDocumentTransaction(
      storage,
      { documentId: "doc_ctx_force", sourcePath: "/notes/ctxf.md", title: "Forced Ctx", frontmatter: {}, embeddingModel: "det" },
      [{ text, entities: [], embedding: deterministicEmbed(text) }],
    );
    await storage
      .engine()
      .query("UPDATE chunks SET contextual_embedded = TRUE WHERE document_id = $1", ["doc_ctx_force"]);

    const seen: string[] = [];
    const capture = (t: string) => {
      seen.push(t);
      return Promise.resolve(deterministicEmbed(t));
    };
    const r = await runEmbedBackfill(storage.engine(), {
      embed: capture,
      forceReembed: true,
      slugs: ["/notes/ctxf.md"],
    });
    expect(r.forceCleared).toBe(1);
    expect(r.embedded).toBe(1);

    const prefix = buildContextualPrefix("Forced Ctx", extractFirstTwoSentences(text), { isCode: false });
    expect(seen).toEqual([wrapChunkForEmbedding(text, prefix, { isCode: false })]);
    // Marker unchanged — the vector it describes is still contextual.
    const marked = await storage
      .engine()
      .query<{ contextual_embedded: boolean }>(
        "SELECT contextual_embedded FROM chunks WHERE document_id = $1",
        ["doc_ctx_force"],
      );
    expect(marked.rows[0]?.contextual_embedded).toBe(true);
  });

  it("counts per-chunk embed failures without aborting the run", async () => {
    let n = 0;
    const flaky = (t: string) => {
      n++;
      if (n === 1) return Promise.reject(new Error("transient bedrock error"));
      return Promise.resolve(deterministicEmbed(t));
    };
    const r = await runEmbedBackfill(storage.engine(), { embed: flaky });
    expect(r.candidates).toBe(2);
    expect(r.embedded).toBe(1);
    expect(r.failed).toBe(1);
  });
});
