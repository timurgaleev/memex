/**
 * indexer-code tests — write doc + chunks + entity_mentions, verify
 * idempotency, no embeddings written, line ranges populated.
 *
 * Uses an in-process PGLite store (mkdtemp) — same pattern as
 * sources_crud.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { indexCodeDocument } from "../src/core/indexer-code.ts";
import { EMPTY_SOURCE_KEY } from "../src/core/empty-source.ts";
import { _resetParsersForTests } from "../src/core/chunkers/parsers.ts";

const dir = mkdtempSync(join(tmpdir(), "tb-indexer-code-"));
let storage: Storage;

beforeAll(async () => {
  storage = new Storage({ dbPath: dir });
  await storage.init();
});

afterAll(async () => {
  await storage.close();
  rmSync(dir, { recursive: true, force: true });
  _resetParsersForTests();
});

describe("indexCodeDocument", () => {
  it("writes one chunk per symbol, no embeddings, line ranges populated", async () => {
    const src = `export function alpha() { return 1; }
export function beta() { return 2; }
`;
    const r = await indexCodeDocument(storage, {
      sourcePath: "src/two.ts",
      text: src,
    });
    expect(r.skipped).toBe(false);
    expect(r.language).toBe("typescript");
    expect(r.chunks).toBe(2);
    expect(r.embeddings).toBe(0); // graph-only
    expect(r.entities).toBeGreaterThan(0);

    // Inspect the chunks table directly.
    const rows = await storage.raw().query<{ start_line: number; end_line: number }>(
      "SELECT start_line, end_line FROM chunks WHERE document_id = $1 ORDER BY chunk_index",
      [r.documentId],
    );
    expect(rows.rows.length).toBe(2);
    expect(rows.rows[0]!.start_line).toBe(1);
    expect(rows.rows[0]!.end_line).toBe(1);
    expect(rows.rows[1]!.start_line).toBe(2);
    expect(rows.rows[1]!.end_line).toBe(2);

    // Embeddings table should have 0 rows for this doc.
    const emb = await storage.raw().query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM embeddings WHERE chunk_id LIKE $1`,
      [`${r.documentId}%`],
    );
    expect(emb.rows[0]?.n).toBe(0);
  });

  it("a symbol-less file (re-export barrel) still gets fallback chunks", async () => {
    // Pure re-exports: export_statement only — no function/class/method, no
    // import_statement. Pre-fix this produced a ZERO-chunk document (dead to
    // search, flagged by orphans-purge); we fall back to windowed module chunks
    // whenever symbol extraction yields nothing.
    const src = `export * from "./alpha.ts";
export * from "./beta.ts";
export { gamma } from "./gamma.ts";
`;
    const r = await indexCodeDocument(storage, {
      sourcePath: "src/barrel.ts",
      text: src,
    });
    expect(r.skipped).toBe(false);
    expect(r.chunks).toBeGreaterThan(0);
    const rows = await storage.raw().query<{ content: string }>(
      "SELECT content FROM chunks WHERE document_id = $1 ORDER BY chunk_index",
      [r.documentId],
    );
    expect(rows.rows.length).toBeGreaterThan(0);
    expect(rows.rows[0]!.content).toContain("gamma");
  });

  it("fallback keeps content of a file whose leading --- lines look like frontmatter", async () => {
    // `---` is a valid SQL comment/separator. A markdown-style frontmatter
    // parse would strip everything between the first two `---` lines and
    // silently drop the INSERT — the fallback must window RAW text.
    const src = `---\nINSERT INTO eval_modes (name) VALUES ('conservative');\n---\n`;
    const r = await indexCodeDocument(storage, {
      sourcePath: "src/migrations/999_dml_only.sql",
      text: src,
    });
    expect(r.chunks).toBeGreaterThan(0);
    const rows = await storage.raw().query<{ content: string }>(
      "SELECT content FROM chunks WHERE document_id = $1",
      [r.documentId],
    );
    expect(rows.rows.map((x) => x.content).join("\n")).toContain("INSERT INTO eval_modes");
  });

  it("marks a blank source so its zero chunks don't read as a corrupt index", async () => {
    // A tracked 0-byte / whitespace-only file has nothing to chunk — the
    // fallback above needs a non-blank body. Zero chunks is the CORRECT outcome
    // here, so the doc carries the empty-source marker and orphans-purge leaves
    // it alone instead of warning about it on every cycle forever.
    const r = await indexCodeDocument(storage, {
      sourcePath: "src/placeholder.ts",
      text: "\n  \n",
    });
    expect(r.skipped).toBe(false);
    expect(r.chunks).toBe(0);
    const rows = await storage.raw().query<{ marked: boolean }>(
      `SELECT frontmatter ? $2 AS marked FROM documents WHERE id = $1`,
      [r.documentId, EMPTY_SOURCE_KEY],
    );
    expect(rows.rows[0]!.marked).toBe(true);

    // ...and the marker clears itself once the file gains content, because a
    // re-index rebuilds the code document's frontmatter wholesale.
    const r2 = await indexCodeDocument(storage, {
      sourcePath: "src/placeholder.ts",
      text: "export function later() { return 1; }\n",
    });
    const after = await storage.raw().query<{ marked: boolean }>(
      `SELECT frontmatter ? $2 AS marked FROM documents WHERE id = $1`,
      [r2.documentId, EMPTY_SOURCE_KEY],
    );
    expect(after.rows[0]!.marked).toBe(false);
  });

  it("re-indexing the same source replaces all prior chunks (idempotent)", async () => {
    const path = "src/idem.ts";
    const r1 = await indexCodeDocument(storage, {
      sourcePath: path,
      text: `function a() {}
function b() {}
function c() {}
`,
    });
    expect(r1.chunks).toBe(3);

    const r2 = await indexCodeDocument(storage, {
      sourcePath: path,
      text: `function a() {}
`,
    });
    expect(r2.documentId).toBe(r1.documentId); // same doc id from sourcePath
    expect(r2.chunks).toBe(1);
    const rows = await storage.raw().query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM chunks WHERE document_id = $1`,
      [r1.documentId],
    );
    expect(rows.rows[0]?.n).toBe(1);
  });

  it("returns skipped=true for an unsupported file extension", async () => {
    const r = await indexCodeDocument(storage, {
      sourcePath: "README.txt",
      text: "hello",
    });
    expect(r.skipped).toBe(true);
    expect(r.language).toBeNull();
    expect(r.chunks).toBe(0);
  });

  it("populates entity_mentions with code-def rows", async () => {
    const r = await indexCodeDocument(storage, {
      sourcePath: "src/ent.ts",
      text: "function unique_def_name() { return 1; }\n",
    });
    expect(r.entities).toBeGreaterThan(0);
    const ent = await storage.raw().query<{ id: string; type: string; name: string }>(
      "SELECT id, type, name FROM entities WHERE name = $1 AND type = $2",
      ["unique_def_name", "code-def"],
    );
    expect(ent.rows.length).toBe(1);
  });

  it("persists per-chunk symbol metadata (name, type, parent, language)", async () => {
    const r = await indexCodeDocument(storage, {
      sourcePath: "src/sym.ts",
      text: `export function topLevel() { return 1; }
class Widget {
  render() { return 2; }
}
`,
    });
    const rows = await storage.raw().query<{
      symbol_name: string | null;
      symbol_type: string | null;
      parent_symbol_path: string[] | null;
      language: string | null;
    }>(
      `SELECT symbol_name, symbol_type, parent_symbol_path, language
       FROM chunks WHERE document_id = $1 ORDER BY chunk_index`,
      [r.documentId],
    );
    // Top-level function: named, kind function, no parent, typescript.
    const top = rows.rows.find((x) => x.symbol_name === "topLevel");
    expect(top).toBeDefined();
    expect(top!.symbol_type).toBe("function");
    expect(top!.parent_symbol_path).toBeNull();
    expect(top!.language).toBe("typescript");
    // Method inside the class: enclosing chain recorded as a TEXT[] array.
    const method = rows.rows.find((x) => x.symbol_name === "render");
    expect(method).toBeDefined();
    expect(method!.symbol_type).toBe("method");
    expect(method!.parent_symbol_path).toEqual(["Widget"]);
    expect(method!.language).toBe("typescript");
    // Every code chunk carries its language.
    expect(rows.rows.every((x) => x.language === "typescript")).toBe(true);
  });

  it("leaves symbol metadata NULL when a chunk omits the fields (markdown path)", async () => {
    // The markdown indexer builds ChunkWrites without symbol fields. Assert
    // the columns default to NULL so the code/markdown split stays clean —
    // exercised via the shared writer directly (no Bedrock dependency).
    const { writeDocumentTransaction } = await import(
      "../src/core/indexer-tx.ts"
    );
    const r = await writeDocumentTransaction(
      storage,
      {
        documentId: "doc_md_nullmeta",
        sourcePath: "notes/plain.md",
        title: "Title",
        frontmatter: {},
      },
      [{ text: "Some prose with no code symbols.", entities: [] }],
    );
    const rows = await storage.raw().query<{
      symbol_name: string | null;
      symbol_type: string | null;
      parent_symbol_path: string[] | null;
      language: string | null;
    }>(
      `SELECT symbol_name, symbol_type, parent_symbol_path, language
       FROM chunks WHERE document_id = $1`,
      [r.documentId],
    );
    expect(rows.rows.length).toBe(1);
    const row = rows.rows[0]!;
    expect(row.symbol_name).toBeNull();
    expect(row.symbol_type).toBeNull();
    expect(row.parent_symbol_path).toBeNull();
    expect(row.language).toBeNull();
  });
});
