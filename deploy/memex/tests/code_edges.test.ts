/**
 * Code call-edge extraction (indexer-code → code_edges_symbol) + the
 * resolve-symbol-edges phase. Offline: code indexing is graph-only (no Bedrock).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { indexCodeDocument } from "../src/core/indexer-code.ts";
import { qualifiedSymbolName } from "../src/core/code-edges.ts";
import { resolveSymbolEdgesPhase } from "../src/core/cycle/resolve-symbol-edges.ts";

let tmp: string;
let storage: Storage;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-code-edges-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("qualifiedSymbolName", () => {
  it("joins parent path with ::, bare at top level", () => {
    expect(qualifiedSymbolName(["Widget"], "render")).toBe("Widget::render");
    expect(qualifiedSymbolName(null, "main")).toBe("main");
    expect(qualifiedSymbolName([], "main")).toBe("main");
  });
});

describe("code edge extraction + resolution", () => {
  it("writes call edges and resolves an unambiguous callee to its chunk", async () => {
    const src = [
      "export class Widget {",
      "  build() { return this.render(); }",
      "  render() { return 1; }",
      "}",
    ].join("\n");
    const r = await indexCodeDocument(storage, { sourcePath: "/widget.ts", text: src });
    expect(r.skipped).toBe(false);

    const e = storage.engine();
    // An edge from build → render should exist.
    const edges = await e.query<{ id: number; to_symbol_qualified: string; from_chunk_id: string }>(
      `SELECT id, to_symbol_qualified, from_chunk_id FROM code_edges_symbol
        WHERE to_symbol_qualified = 'render'`,
    );
    expect(edges.rows.length).toBeGreaterThanOrEqual(1);

    // Before resolution: not resolved.
    const before = await e.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM code_edges_symbol
        WHERE edge_metadata ? 'resolved_chunk_id'`,
    );
    expect(before.rows[0]!.n).toBe(0);

    const phase = await resolveSymbolEdgesPhase(e);
    expect(phase.resolved).toBeGreaterThanOrEqual(1);
    expect(phase.errors).toEqual([]);

    // After: the render edge resolves to the chunk whose symbol_name = render.
    const renderChunk = await e.query<{ id: string }>(
      `SELECT id FROM chunks WHERE document_id = $1 AND symbol_name = 'render'`,
      [r.documentId],
    );
    const resolved = await e.query<{ rid: string }>(
      `SELECT edge_metadata->>'resolved_chunk_id' AS rid FROM code_edges_symbol
        WHERE to_symbol_qualified = 'render' AND edge_metadata ? 'resolved_chunk_id'`,
    );
    expect(resolved.rows.length).toBeGreaterThanOrEqual(1);
    expect(resolved.rows[0]!.rid).toBe(renderChunk.rows[0]!.id);
  });

  it("is incremental: a second phase run resolves nothing new", async () => {
    const phase = await resolveSymbolEdgesPhase(storage.engine());
    expect(phase.documents).toBe(0); // all code chunks already stamped
    expect(phase.resolved).toBe(0);
  });
});
