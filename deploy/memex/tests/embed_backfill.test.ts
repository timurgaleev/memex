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
