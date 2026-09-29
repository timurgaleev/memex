/**
 * Contextual re-embed (`memex reindex --contextual`) — whole-corpus from-DB
 * re-embed that applies the `<context>title\nsynopsis</context>` wrapper to
 * each embeddable chunk's embedding INPUT (canonical chunk text untouched).
 *
 * Every embed goes through an INJECTED recorder — no Bedrock. The recorder
 * captures the exact text it was asked to embed, so we can assert the prefix
 * was (or was not) applied. Seeds cover: a normal on-disk doc, a `page://`
 * inline doc with no file on disk, and a code doc (graph-only).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { writeDocumentTransaction } from "../src/core/indexer-tx.ts";
import { runContextualReembed } from "../src/core/contextual-reembed.ts";
import { deterministicEmbed } from "./det-embed.ts";

let tmp: string;
let storage: Storage;
/** Every text the injected embedder was asked to embed, in call order. */
let embedded: string[];

/** Recording embedder — captures input, returns a deterministic 1024-dim vec. */
const recordingEmbed = (t: string): Promise<number[]> => {
  embedded.push(t);
  return Promise.resolve(deterministicEmbed(t));
};

async function markedCount(docId: string): Promise<number> {
  const r = await storage.engine().query<{ n: number }>(
    "SELECT COUNT(*)::int AS n FROM chunks WHERE document_id = $1 AND contextual_embedded",
    [docId],
  );
  return r.rows[0]?.n ?? 0;
}

async function embeddingDim(chunkId: string): Promise<number | null> {
  const r = await storage.engine().query<{ vector: string }>(
    "SELECT vector::text AS vector FROM embeddings WHERE chunk_id = $1",
    [chunkId],
  );
  const raw = r.rows[0]?.vector;
  if (!raw) return null;
  return (JSON.parse(raw) as number[]).length;
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-ctx-reembed-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  embedded = [];

  // Normal on-disk markdown doc — two chunks. Opening chunk supplies the
  // synopsis (first two sentences).
  await writeDocumentTransaction(
    storage,
    { documentId: "doc_md", sourcePath: "/notes/retrieval.md", title: "Retrieval Notes", frontmatter: {}, embeddingModel: "det" },
    [
      { text: "Hybrid search fuses vector and keyword arms. RRF blends the two rankings. Extra tail.", entities: [], embedding: deterministicEmbed("seed") },
      { text: "The second chunk discusses reranking.", entities: [], embedding: deterministicEmbed("seed") },
    ],
  );

  // page:// inline doc — no file on disk, body lives only in the page store.
  // Its chunks are still in the chunks table, so a from-DB pass must reach it.
  await writeDocumentTransaction(
    storage,
    { documentId: "doc_page", sourcePath: "page://gmail-thread-42", title: "Invoice thread", frontmatter: {}, embeddingModel: "det" },
    [{ text: "Payment is due Friday. Please confirm receipt.", entities: [], embedding: deterministicEmbed("seed") }],
  );

  // Code doc — graph-only, no embeddings row by design.
  await writeDocumentTransaction(
    storage,
    { documentId: "doc_code", sourcePath: "/src/x.ts", title: "x.ts", frontmatter: { kind: "code", language: "typescript" }, embeddingModel: "det" },
    [{ text: "export function alpha() { return 1; }", entities: [], symbolName: "alpha" }],
  );
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("contextual re-embed", () => {
  it("wraps a normal chunk with its <context>title\\nsynopsis</context> prefix", async () => {
    const r = await runContextualReembed(storage.engine(), { embed: recordingEmbed });
    expect(r.failed).toBe(0);

    const expectedPrefix =
      "<context>Retrieval Notes\nHybrid search fuses vector and keyword arms. RRF blends the two rankings.\n</context>\n";
    // The opening chunk's embedding input is prefix + raw chunk text.
    const openingInput = embedded.find((t) => t.includes("Hybrid search fuses"));
    expect(openingInput).toBeDefined();
    expect(openingInput!.startsWith(expectedPrefix)).toBe(true);

    // The second chunk carries the SAME document-level prefix.
    const secondInput = embedded.find((t) => t.includes("discusses reranking"));
    expect(secondInput!.startsWith(expectedPrefix)).toBe(true);

    // Canonical chunk text stays unwrapped in the DB.
    const stored = await storage.engine().query<{ content: string }>(
      "SELECT content FROM chunks WHERE id = $1", ["doc_md_c0"],
    );
    expect(stored.rows[0]?.content.startsWith("<context>")).toBe(false);
  });

  it("covers a page:// doc that has no file on disk", async () => {
    await runContextualReembed(storage.engine(), { embed: recordingEmbed });
    const pageInput = embedded.find((t) => t.includes("Payment is due Friday"));
    expect(pageInput).toBeDefined();
    expect(pageInput!.startsWith("<context>Invoice thread\n")).toBe(true);
    expect(await markedCount("doc_page")).toBe(1);
  });

  it("never embeds a code doc's chunk (graph-only invariant preserved)", async () => {
    await runContextualReembed(storage.engine(), { embed: recordingEmbed });
    // The code chunk text is never handed to the embedder...
    expect(embedded.some((t) => t.includes("export function alpha"))).toBe(false);
    // ...and gains no embeddings row (absence is what keeps code out of the
    // vector arm), and is never marked.
    const codeEmb = await storage.engine().query<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM embeddings WHERE chunk_id = 'doc_code_c0'",
    );
    expect(codeEmb.rows[0]?.n).toBe(0);
    expect(await markedCount("doc_code")).toBe(0);
  });

  it("is idempotent — a second run skips already-marked chunks", async () => {
    const first = await runContextualReembed(storage.engine(), { embed: recordingEmbed });
    expect(first.chunks).toBe(3); // 2 md + 1 page
    const afterFirst = embedded.length;

    embedded = [];
    const second = await runContextualReembed(storage.engine(), { embed: recordingEmbed });
    expect(second.chunks).toBe(0);
    expect(second.documents).toBe(0);
    expect(embedded.length).toBe(0); // embedder not called again
    expect(afterFirst).toBe(3);
  });

  it("--force re-embeds already-marked chunks", async () => {
    await runContextualReembed(storage.engine(), { embed: recordingEmbed });
    embedded = [];
    const forced = await runContextualReembed(storage.engine(), { embed: recordingEmbed, force: true });
    expect(forced.chunks).toBe(3);
    expect(embedded.length).toBe(3);
  });

  it("keeps the vector dimension unchanged (1024)", async () => {
    await runContextualReembed(storage.engine(), { embed: recordingEmbed });
    expect(await embeddingDim("doc_md_c0")).toBe(1024);
    expect(await embeddingDim("doc_page_c0")).toBe(1024);
  });

  it("dry-run counts the workload and writes nothing", async () => {
    const r = await runContextualReembed(storage.engine(), { embed: recordingEmbed, dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(r.chunks).toBe(3);
    expect(r.documents).toBe(2); // md + page
    expect(embedded.length).toBe(0);
    expect(await markedCount("doc_md")).toBe(0);
  });
});
