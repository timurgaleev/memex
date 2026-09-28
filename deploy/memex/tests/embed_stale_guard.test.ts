/**
 * A vector computed from a chunk's text must never land on that chunk after
 * a re-index changed the text under the same positional id (`<doc>_c<i>`).
 * Both the embed backfill and the contextual re-embed embed outside any
 * transaction, so the embedder here re-chunks the document mid-call.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { writeDocumentTransaction } from "../src/core/indexer-tx.ts";
import { runEmbedBackfill } from "../src/core/embed-backfill.ts";
import { runContextualReembed } from "../src/core/contextual-reembed.ts";
import { deterministicEmbed } from "./det-embed.ts";

let tmp: string;
let storage: Storage;

const OLD = "the original chunk text about retrieval";
const NEW = "rewritten chunk text about something else";
const OTHER = "a second chunk that nobody touches";

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-stale-guard-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});
afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function seed(embedded: boolean): Promise<void> {
  await writeDocumentTransaction(
    storage,
    { documentId: "doc_s", sourcePath: "/notes/s.md", title: "s", frontmatter: {}, embeddingModel: "det" },
    [
      { text: OLD, entities: [], ...(embedded ? { embedding: deterministicEmbed(OLD) } : {}) },
      { text: OTHER, entities: [], ...(embedded ? { embedding: deterministicEmbed(OTHER) } : {}) },
    ],
  );
}

/** Re-chunk: the first chunk keeps its id but now holds NEW (no vector yet). */
async function rechunk(): Promise<void> {
  await writeDocumentTransaction(
    storage,
    { documentId: "doc_s", sourcePath: "/notes/s.md", title: "s", frontmatter: {}, embeddingModel: "det" },
    [
      { text: NEW, entities: [] },
      { text: OTHER, entities: [], embedding: deterministicEmbed(OTHER) },
    ],
  );
}

/** An embedder that re-chunks the document the first time it sees OLD. */
function rechunkingEmbed(): (t: string) => Promise<number[]> {
  let fired = false;
  return async (t: string) => {
    if (!fired && t.includes(OLD)) {
      fired = true;
      await rechunk();
    }
    return deterministicEmbed(t);
  };
}

async function vectorFor(chunkId: string): Promise<string | null> {
  const r = await storage.engine().query<{ v: string }>(
    "SELECT vector::text AS v FROM embeddings WHERE chunk_id = $1",
    [chunkId],
  );
  return r.rows[0]?.v ?? null;
}

/** Cosine distance between a chunk's stored vector and the vector of `text`. */
async function distanceTo(chunkId: string, text: string): Promise<number> {
  const r = await storage.engine().query<{ d: number }>(
    "SELECT (vector <=> $2::vector)::float8 AS d FROM embeddings WHERE chunk_id = $1",
    [chunkId, JSON.stringify(deterministicEmbed(text))],
  );
  return Number(r.rows[0]!.d);
}

describe("embed backfill", () => {
  it("skips and counts a chunk whose text changed mid-embed", async () => {
    await seed(false);
    const r = await runEmbedBackfill(storage.engine(), { embed: rechunkingEmbed(), concurrency: 1 });
    expect(r.stale).toBe(1);
    // The rechunk wrote OTHER's vector itself, so the backfill added nothing there.
    expect(r.embedded).toBe(0);
    expect(await vectorFor("doc_s_c0")).toBeNull();

    // The next run embeds the text that is actually there.
    const again = await runEmbedBackfill(storage.engine(), { embed: async (t) => deterministicEmbed(t) });
    expect(again.embedded).toBe(1);
    expect(again.stale).toBe(0);
    expect(await distanceTo("doc_s_c0", NEW)).toBeLessThan(1e-6);
  });
});

describe("contextual re-embed", () => {
  it("never writes the old text's vector onto the re-chunked chunk", async () => {
    await seed(true);
    const r = await runContextualReembed(storage.engine(), { embed: rechunkingEmbed(), force: true });
    expect(r.stale).toBe(1);
    expect(r.chunks).toBe(1);
    // The re-chunked chunk has no vector (the indexer left it for a backfill)
    // and is not marked as contextually embedded.
    expect(await vectorFor("doc_s_c0")).toBeNull();
    const marks = await storage.engine().query<{ id: string; contextual_embedded: boolean }>(
      "SELECT id, contextual_embedded FROM chunks WHERE document_id = 'doc_s' ORDER BY chunk_index",
    );
    expect(marks.rows).toEqual([
      { id: "doc_s_c0", contextual_embedded: false },
      { id: "doc_s_c1", contextual_embedded: true },
    ]);
  });
});
