/**
 * Bounded query-embed deadline — the vector arm runs against a wall-clock
 * budget and must never let a slow/stuck/throwing embedder block the search.
 *
 * Driven through the hermetic `embedQuery` injection seam (no Bedrock):
 *   - a throwing embedder    → keyword-only fallback (no throw, results returned)
 *   - a never-settling embedder → the deadline fires → keyword-only fallback
 *   - a control embedder       → the vector arm succeeds end to end
 *
 * PGLite-backed and deterministic: the corpus carries seeded deterministic
 * vectors, so the control case exercises the real vectorSearch + RRF path.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { writeDocumentTransaction } from "../src/core/indexer-tx.ts";
import { hybridSearch } from "../src/core/search/index.ts";
import { deterministicEmbed, deterministicEmbedQuery } from "./det-embed.ts";

const CORPUS: { id: string; content: string }[] = [
  { id: "doc_zigbee", content: "home assistant zigbee pairing setup guide" },
  { id: "doc_models", content: "bedrock nova model selection titan embeddings" },
  { id: "doc_noise", content: "unrelated lorem ipsum filler placeholder prose" },
];

const toDocId = (chunkId: string): string => chunkId.replace(/_c\d+$/, "");

let tmp: string;
let storage: Storage;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-embed-deadline-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  for (const d of CORPUS) {
    await writeDocumentTransaction(
      storage,
      {
        documentId: d.id,
        sourcePath: `/${d.id}.md`,
        title: d.id,
        frontmatter: {},
        embeddingModel: "deterministic-test",
      },
      [{ text: d.content, entities: [], embedding: deterministicEmbed(d.content) }],
    );
  }
});

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

const search = (embedQuery: (text: string) => Promise<number[]>) =>
  hybridSearch(storage, "zigbee pairing setup", {
    k: 5,
    intent: "topic",
    noExpansion: true,
    noCache: true,
    embedQuery,
  });

describe("bounded query-embed deadline", () => {
  it("falls back to keyword-only when the embedder throws", async () => {
    const result = await search(async () => {
      throw new Error("embedder boom");
    });
    expect(result.length).toBeGreaterThan(0);
    expect(result.map((h) => toDocId(h.chunkId))).toContain("doc_zigbee");
  });

  it("falls back to keyword-only when the embedder never settles", async () => {
    const result = await search(() => new Promise<number[]>(() => {}));
    expect(result.length).toBeGreaterThan(0);
    expect(result.map((h) => toDocId(h.chunkId))).toContain("doc_zigbee");
  }, 15_000);

  it("the control embedder succeeds (vector arm runs)", async () => {
    const result = await search(deterministicEmbedQuery);
    expect(result.length).toBeGreaterThan(0);
    expect(toDocId(result[0]!.chunkId)).toBe("doc_zigbee");
  });
});
