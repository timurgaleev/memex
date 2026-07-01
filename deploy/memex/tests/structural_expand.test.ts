/**
 * Structural two-pass expansion (near_symbol / walk_depth) over the code call
 * graph. Offline: code indexing is graph-only (no Bedrock). Mirrors the
 * code_edges.test.ts harness — index a call chain, resolve symbol edges, then
 * drive expandAnchors directly.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { indexCodeDocument } from "../src/core/indexer-code.ts";
import { resolveSymbolEdgesPhase } from "../src/core/cycle/resolve-symbol-edges.ts";
import { expandAnchors } from "../src/core/search/structural-expand.ts";

let tmp: string;
let storage: Storage;
let chunkA: string;
let chunkB: string;
let chunkC: string;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-structural-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();

  // A → B → C call chain across three method defs (one chunk each).
  const src = [
    "export class Svc {",
    "  a() { return this.b(); }",
    "  b() { return this.c(); }",
    "  c() { return 1; }",
    "}",
  ].join("\n");
  const r = await indexCodeDocument(storage, { sourcePath: "/svc.ts", text: src });
  expect(r.skipped).toBe(false);
  const phase = await resolveSymbolEdgesPhase(storage.engine());
  expect(phase.errors).toEqual([]);

  const e = storage.engine();
  const id = async (name: string): Promise<string> => {
    const q = await e.query<{ id: string }>(
      `SELECT id FROM chunks WHERE document_id = $1 AND symbol_name = $2`,
      [r.documentId, name],
    );
    return q.rows[0]!.id;
  };
  chunkA = await id("a");
  chunkB = await id("b");
  chunkC = await id("c");
}, 60000);

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("expandAnchors", () => {
  const ids = (rows: { id: string }[]) => new Set(rows.map((x) => x.id));

  it("walkDepth 0 with no near_symbol is a no-op (anchors unchanged)", async () => {
    const out = await expandAnchors(storage.engine(), [{ id: chunkA, score: 1 }], {
      walkDepth: 0,
    });
    expect(out).toEqual([{ id: chunkA, score: 1 }]);
  });

  it("walkDepth 1 surfaces the direct callee with 1/(1+hop) decay", async () => {
    const out = await expandAnchors(storage.engine(), [{ id: chunkA, score: 1 }], {
      walkDepth: 1,
    });
    const set = ids(out);
    expect(set.has(chunkA)).toBe(true);
    expect(set.has(chunkB)).toBe(true);
    expect(set.has(chunkC)).toBe(false); // 2 hops away — beyond depth 1
    const b = out.find((x) => x.id === chunkB)!;
    expect(b.score).toBeCloseTo(0.5); // 1 * 1/(1+1)
  });

  it("walkDepth 2 reaches the transitive callee", async () => {
    const out = await expandAnchors(storage.engine(), [{ id: chunkA, score: 1 }], {
      walkDepth: 2,
    });
    const set = ids(out);
    expect(set.has(chunkB)).toBe(true);
    expect(set.has(chunkC)).toBe(true);
  });

  it("walkDepth is capped at 2 (a larger value does not reach further)", async () => {
    const deep = await expandAnchors(storage.engine(), [{ id: chunkA, score: 1 }], {
      walkDepth: 5,
    });
    const atTwo = await expandAnchors(storage.engine(), [{ id: chunkA, score: 1 }], {
      walkDepth: 2,
    });
    expect(ids(deep)).toEqual(ids(atTwo));
  });

  it("near_symbol seeds an anchor even with no text anchors", async () => {
    const out = await expandAnchors(storage.engine(), [], {
      nearSymbol: "Svc::b",
    });
    expect(ids(out).has(chunkB)).toBe(true);
  });

  it("near_symbol + walkDepth 1 walks from the seeded anchor", async () => {
    const out = await expandAnchors(storage.engine(), [], {
      nearSymbol: "Svc::a",
      walkDepth: 1,
    });
    const set = ids(out);
    expect(set.has(chunkA)).toBe(true);
    expect(set.has(chunkB)).toBe(true);
  });

  it("source scoping: a non-matching source excludes cross-boundary neighbors", async () => {
    // Unscoped: the neighbor is reachable.
    const unscoped = await expandAnchors(storage.engine(), [{ id: chunkA, score: 1 }], {
      walkDepth: 1,
    });
    expect(ids(unscoped).has(chunkB)).toBe(true);

    // Scoped to a source the fixture's documents don't belong to: the anchor
    // stays (caller-supplied), but no neighbor crosses the source boundary.
    const offScope = await expandAnchors(storage.engine(), [{ id: chunkA, score: 1 }], {
      walkDepth: 1,
      sourceIds: ["nonexistent-source"],
    });
    expect(ids(offScope).has(chunkA)).toBe(true);
    expect(ids(offScope).has(chunkB)).toBe(false);
  });
});
