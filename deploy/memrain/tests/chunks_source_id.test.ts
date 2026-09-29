/**
 * chunks.source_id — the denormalized per-chunk tenant mirror (migration 058).
 * Verifies the column + partial index exist after boot and that the writer
 * (indexer-tx) keeps a chunk's source_id equal to its parent document's.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { writeDocumentTransaction } from "../src/core/indexer-tx.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-chunksrc-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});
afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("migration 058 — schema shape", () => {
  it("adds the nullable chunks.source_id column with no default", async () => {
    const e = storage.engine();
    const r = await e.query<{ is_nullable: string; column_default: string | null }>(
      `SELECT is_nullable, column_default
         FROM information_schema.columns
        WHERE table_name = 'chunks' AND column_name = 'source_id'`,
    );
    expect(r.rows[0]?.is_nullable).toBe("YES");
    expect(r.rows[0]?.column_default ?? null).toBeNull();
  });

  it("creates the partial idx_chunks_source_id index", async () => {
    const e = storage.engine();
    const r = await e.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE indexname = 'idx_chunks_source_id'",
    );
    expect(r.rows[0]?.indexname).toBe("idx_chunks_source_id");
  });
});

async function chunkSources(id: string): Promise<Array<string | null>> {
  const r = await storage.engine().query<{ source_id: string | null }>(
    "SELECT source_id FROM chunks WHERE document_id = $1 ORDER BY chunk_index",
    [id],
  );
  return r.rows.map((row) => row.source_id);
}

describe("migration 058 — writer keeps chunks.source_id == documents.source_id", () => {
  it("stamps an explicit tenant source onto every chunk", async () => {
    await storage.engine().query(
      "INSERT INTO sources (id, kind, path_prefix) VALUES ($1, 'other', $2) ON CONFLICT (id) DO NOTHING",
      ["tenant_a", "__tenant_a__"],
    );
    await writeDocumentTransaction(
      storage,
      { documentId: "d_tenant", sourcePath: "/a.md", title: "a", frontmatter: {}, embeddingModel: "det", sourceId: "tenant_a" },
      [{ text: "one", entities: [] }, { text: "two", entities: [] }],
    );
    const doc = await storage.engine().query<{ source_id: string | null }>(
      "SELECT source_id FROM documents WHERE id = $1",
      ["d_tenant"],
    );
    expect(doc.rows[0]?.source_id).toBe("tenant_a");
    expect(await chunkSources("d_tenant")).toEqual(["tenant_a", "tenant_a"]);
  });

  it("leaves chunks.source_id NULL for an unclassified doc (no 'default' freeze)", async () => {
    await writeDocumentTransaction(
      storage,
      { documentId: "d_null", sourcePath: "/b.md", title: "b", frontmatter: {}, embeddingModel: "det" },
      [{ text: "body", entities: [] }],
    );
    const doc = await storage.engine().query<{ source_id: string | null }>(
      "SELECT source_id FROM documents WHERE id = $1",
      ["d_null"],
    );
    expect(doc.rows[0]?.source_id ?? null).toBeNull();
    expect(await chunkSources("d_null")).toEqual([null]);
  });

  it("preserves the prior source on reindex (COALESCE), so chunks track it", async () => {
    await storage.engine().query(
      "INSERT INTO sources (id, kind, path_prefix) VALUES ($1, 'other', $2) ON CONFLICT (id) DO NOTHING",
      ["tenant_b", "__tenant_b__"],
    );
    await writeDocumentTransaction(
      storage,
      { documentId: "d_re", sourcePath: "/c.md", title: "c", frontmatter: {}, embeddingModel: "det", sourceId: "tenant_b" },
      [{ text: "v1", entities: [] }],
    );
    // Reindex WITHOUT a sourceId — the upsert keeps tenant_b, so must the chunks.
    await writeDocumentTransaction(
      storage,
      { documentId: "d_re", sourcePath: "/c.md", title: "c", frontmatter: {}, embeddingModel: "det" },
      [{ text: "v2a", entities: [] }, { text: "v2b", entities: [] }],
    );
    expect(await chunkSources("d_re")).toEqual(["tenant_b", "tenant_b"]);
  });
});
