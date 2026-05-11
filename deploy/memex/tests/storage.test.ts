import { test, expect } from "bun:test";
import { Storage } from "../src/core/storage.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("Storage opens, applies schema, reports zero stats", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tb-storage-"));
  try {
    const s = new Storage({ dbPath: dir });
    await s.init();
    const stats = await s.stats();
    expect(stats).toEqual({ documents: 0, chunks: 0, embeddings: 0 });
    await s.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Storage init is idempotent (second init is a no-op)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tb-storage-"));
  try {
    const s1 = new Storage({ dbPath: dir });
    await s1.init();
    await s1.close();
    // Open the same dir again — schema already applied, should be quick + safe.
    const s2 = new Storage({ dbPath: dir });
    await s2.init();
    const stats = await s2.stats();
    expect(stats.documents).toBe(0);
    await s2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Storage exposes pgvector — embeddings table accepts a 1024-dim vector", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tb-storage-"));
  try {
    const s = new Storage({ dbPath: dir });
    await s.init();

    // Probe the schema by inserting a document, chunk, and embedding via
    // the Engine. A malformed CREATE TABLE would fail here, not in stats().
    const engine = s.engine();
    await engine.query(
      "INSERT INTO documents (id, source_path, title) VALUES ($1, $2, $3)",
      ["doc1", "test.md", "Test"],
    );
    await engine.query(
      "INSERT INTO chunks (id, document_id, chunk_index, content) VALUES ($1, $2, $3, $4)",
      ["chunk1", "doc1", 0, "hello world"],
    );
    const vec = new Array(1024).fill(0.1);
    await engine.query(
      "INSERT INTO embeddings (chunk_id, vector, model) VALUES ($1, $2::vector, $3)",
      ["chunk1", JSON.stringify(vec), "amazon.titan-embed-text-v2:0"],
    );

    const stats = await s.stats();
    expect(stats).toEqual({ documents: 1, chunks: 1, embeddings: 1 });

    await s.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
