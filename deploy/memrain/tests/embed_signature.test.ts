/**
 * Embedding provenance signature (migration 066) + concurrent backfill.
 *
 * Every embeddings row is stamped `provider:model:dims` at write time. The
 * backfill's OPT-IN signature-invalidation deletes only rows whose stored
 * signature differs from the current one (a real model/dim swap) and never
 * touches a NULL (legacy) signature, so it cannot force a full re-embed of the
 * existing corpus. The bounded worker pool embeds candidates concurrently
 * (behaviour-neutral: same rows, faster).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { writeDocumentTransaction } from "../src/core/indexer-tx.ts";
import { runEmbedBackfill } from "../src/core/embed-backfill.ts";
import { embeddingSignature, DEFAULT_MODEL_ID } from "../src/core/embedding.ts";
import { deterministicEmbed } from "./det-embed.ts";

const detEmbed = (t: string) => Promise.resolve(deterministicEmbed(t));

let tmp: string;
let storage: Storage;

async function sigOf(chunkId: string): Promise<string | null> {
  const r = await storage
    .engine()
    .query<{ s: string | null }>(
      "SELECT embedding_signature AS s FROM embeddings WHERE chunk_id = $1",
      [chunkId],
    );
  return r.rows[0]?.s ?? null;
}

async function embeddingCount(): Promise<number> {
  const r = await storage
    .engine()
    .query<{ n: number }>("SELECT COUNT(*)::int AS n FROM embeddings");
  return r.rows[0]?.n ?? 0;
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-embed-sig-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("embedding signature stamping", () => {
  it("stamps the indexer-written embedding with provider:model:dims", async () => {
    await writeDocumentTransaction(
      storage,
      { documentId: "doc_a", sourcePath: "/notes/a.md", title: "a", frontmatter: {}, embeddingModel: "titanic" },
      [{ text: "chunk with a vector", entities: [], embedding: deterministicEmbed("chunk with a vector") }],
    );
    expect(await sigOf("doc_a_c0")).toBe(embeddingSignature("titanic", 1024));
  });

  it("stamps a backfilled embedding with the current model signature", async () => {
    await writeDocumentTransaction(
      storage,
      { documentId: "doc_b", sourcePath: "/notes/b.md", title: "b", frontmatter: {}, embeddingModel: "det" },
      [{ text: "un-embedded chunk", entities: [] }],
    );
    const r = await runEmbedBackfill(storage.engine(), { embed: detEmbed });
    expect(r.embedded).toBe(1);
    expect(await sigOf("doc_b_c0")).toBe(embeddingSignature(DEFAULT_MODEL_ID, 1024));
  });
});

describe("signature auto-invalidation (opt-in)", () => {
  async function seedMixedSignatures(): Promise<void> {
    // Three already-embedded chunks; rewrite their signatures to represent the
    // three provenance states.
    await writeDocumentTransaction(
      storage,
      { documentId: "doc_mix", sourcePath: "/notes/mix.md", title: "mix", frontmatter: {}, embeddingModel: "det" },
      [
        { text: "current sig chunk", entities: [], embedding: deterministicEmbed("current sig chunk") },
        { text: "stale sig chunk", entities: [], embedding: deterministicEmbed("stale sig chunk") },
        { text: "legacy null sig chunk", entities: [], embedding: deterministicEmbed("legacy null sig chunk") },
      ],
    );
    const current = embeddingSignature(DEFAULT_MODEL_ID, 1024);
    await storage.engine().query(
      "UPDATE embeddings SET embedding_signature = $1 WHERE chunk_id = 'doc_mix_c0'",
      [current],
    );
    await storage.engine().query(
      "UPDATE embeddings SET embedding_signature = 'bedrock:old-model:1024' WHERE chunk_id = 'doc_mix_c1'",
    );
    await storage.engine().query(
      "UPDATE embeddings SET embedding_signature = NULL WHERE chunk_id = 'doc_mix_c2'",
    );
  }

  it("re-embeds only the stale-signature row; leaves current + NULL untouched", async () => {
    await seedMixedSignatures();
    const before = await embeddingCount();
    const r = await runEmbedBackfill(storage.engine(), {
      embed: detEmbed,
      reembedOnSignatureChange: true,
    });
    expect(r.signatureStale).toBe(1); // only doc_mix_c1
    expect(r.embedded).toBe(1); // re-embedded exactly that one
    expect(await embeddingCount()).toBe(before); // deleted then re-inserted → net 0

    expect(await sigOf("doc_mix_c0")).toBe(embeddingSignature(DEFAULT_MODEL_ID, 1024)); // current, kept
    expect(await sigOf("doc_mix_c1")).toBe(embeddingSignature(DEFAULT_MODEL_ID, 1024)); // re-embedded → current
    expect(await sigOf("doc_mix_c2")).toBeNull(); // legacy NULL, never touched
  });

  it("does nothing without the opt-in flag (default OFF)", async () => {
    await seedMixedSignatures();
    const r = await runEmbedBackfill(storage.engine(), { embed: detEmbed });
    expect(r.signatureStale).toBe(0);
    expect(r.embedded).toBe(0); // no MISSING embeddings, and no invalidation
    expect(await sigOf("doc_mix_c1")).toBe("bedrock:old-model:1024"); // stale row survives
  });

  it("dry-run counts stale rows but deletes nothing", async () => {
    await seedMixedSignatures();
    const before = await embeddingCount();
    const r = await runEmbedBackfill(storage.engine(), {
      embed: detEmbed,
      reembedOnSignatureChange: true,
      dryRun: true,
    });
    expect(r.signatureStale).toBe(1);
    expect(r.embedded).toBe(0);
    expect(await embeddingCount()).toBe(before);
    expect(await sigOf("doc_mix_c1")).toBe("bedrock:old-model:1024"); // untouched
  });
});

describe("concurrent backfill", () => {
  it("embeds every candidate under a bounded pool (behaviour-neutral)", async () => {
    const chunks = Array.from({ length: 12 }, (_, i) => ({
      text: `un-embedded chunk number ${i}`,
      entities: [] as never[],
    }));
    await writeDocumentTransaction(
      storage,
      { documentId: "doc_many", sourcePath: "/notes/many.md", title: "many", frontmatter: {}, embeddingModel: "det" },
      chunks,
    );
    const r = await runEmbedBackfill(storage.engine(), { embed: detEmbed, concurrency: 4 });
    expect(r.candidates).toBe(12);
    expect(r.embedded).toBe(12);
    expect(r.failed).toBe(0);
    expect(await embeddingCount()).toBe(12);
    // Every row carries the current signature.
    const sig = await storage
      .engine()
      .query<{ n: number }>(
        "SELECT COUNT(*)::int AS n FROM embeddings WHERE embedding_signature = $1",
        [embeddingSignature(DEFAULT_MODEL_ID, 1024)],
      );
    expect(sig.rows[0]?.n).toBe(12);
  });
});
