/**
 * A grammar that cannot be linked must DEGRADE the file to text chunks, never
 * drop it.
 *
 * Before this guard, indexCodeDocument called chunkCode bare: a throw escaped
 * before writeDocumentTransaction, so no document row was written at all — no
 * chunks, no embeddings, invisible to both search arms. The sweep counted the
 * error and moved on. That is how every shell script stayed out of the brain
 * while the boot log printed a number.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { indexCodeDocument, _resetGrammarFallbackWarningsForTests } from "../src/core/indexer-code.ts";
import { WASM_FILES, _resetParsersForTests } from "../src/core/chunkers/parsers.ts";

const dirs: string[] = [];

function brokenGrammarDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "memex-broken-grammar-"));
  writeFileSync(join(dir, WASM_FILES.bash), Buffer.from("\0asm   not-a-grammar"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  delete process.env.MEMEX_WASM_DIR;
  _resetParsersForTests();
  _resetGrammarFallbackWarningsForTests();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("a file whose grammar cannot link is still indexed, as text", async () => {
  process.env.MEMEX_WASM_DIR = brokenGrammarDir();
  _resetParsersForTests();

  const dbDir = mkdtempSync(join(tmpdir(), "memex-fallback-db-"));
  dirs.push(dbDir);
  const storage = new Storage({ dbPath: dbDir } as never);
  await storage.init();
  try {
    await indexCodeDocument(storage, {
      sourcePath: "/repo-source/scripts/deploy.sh",
      text: "#!/bin/sh\ncase $1 in\n  a) echo a;;\nesac\n",
      mtimeMs: 1_000,
    } as never);

    const docs = await storage.raw().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM documents WHERE source_path = $1`,
      ["/repo-source/scripts/deploy.sh"],
    );
    expect(docs.rows[0]!.n).toBe(1);

    const chunks = await storage.raw().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM chunks c
         JOIN documents d ON d.id = c.document_id
        WHERE d.source_path = $1`,
      ["/repo-source/scripts/deploy.sh"],
    );
    expect(chunks.rows[0]!.n).toBeGreaterThan(0);

    // No mtime stamp: the sweep must retry this file, so fixing the grammar
    // heals the corpus without an operator running a manual reindex.
    const stamp = await storage.raw().query<{ last_indexed_mtime: number | null }>(
      `SELECT last_indexed_mtime FROM documents WHERE source_path = $1`,
      ["/repo-source/scripts/deploy.sh"],
    );
    expect(stamp.rows[0]!.last_indexed_mtime).toBeNull();
  } finally {
    await storage.close();
  }
});
