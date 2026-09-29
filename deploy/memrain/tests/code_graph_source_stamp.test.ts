/**
 * Code edges carry the source of the document they were extracted from, so a
 * scoped caller walks its own call graph instead of an empty one, and an edge
 * with no source never leaks into a scoped structural expansion. Volunteer
 * events carry their page's source so the usage stats can be scoped too.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { backfillDocumentSources, registerSource } from "../src/core/sources.ts";
import { indexCodeDocument } from "../src/core/indexer-code.ts";
import { runRecursiveWalk } from "../src/core/code-walk.ts";
import { expandAnchors } from "../src/core/search/structural-expand.ts";
import { putPage } from "../src/core/pages.ts";
import { insertVolunteerEvents } from "../src/core/context/volunteer-events.ts";
import { volunteerUsageStats } from "../src/core/context/volunteer.ts";

setDefaultTimeout(60000);

let tmp: string;
let storage: Storage;
let documentId = "";

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-code-source-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  await registerSource(storage.engine(), { id: "tenant-a", kind: "vault", pathPrefix: "/tenant-a" });
  await registerSource(storage.engine(), { id: "tenant-b", kind: "vault", pathPrefix: "/tenant-b" });
  const src = [
    "export class Svc {",
    "  a() { return this.b(); }",
    "  b() { return 1; }",
    "}",
  ].join("\n");
  const r = await indexCodeDocument(storage, { sourcePath: "/tenant-a/svc.ts", text: src, sourceId: "tenant-a" });
  documentId = r.documentId;
});

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("code edges carry their document's source", () => {
  it("stamps every edge with the source of the indexed document", async () => {
    const doc = await storage.engine().query<{ source_id: string }>(`SELECT source_id FROM documents WHERE id = $1`, [documentId]);
    expect(doc.rows[0]!.source_id).toBe("tenant-a");
    const edges = await storage.engine().query<{ source_id: string | null }>(
      `SELECT DISTINCT e.source_id FROM code_edges_symbol e JOIN chunks c ON c.id = e.from_chunk_id WHERE c.document_id = $1`,
      [documentId],
    );
    expect(edges.rows.map((row) => row.source_id)).toEqual(["tenant-a"]);
  });

  it("lets the owning tenant walk its call graph", async () => {
    const own = await runRecursiveWalk(storage.engine(), "Svc::a", { direction: "callees", exact: true, sourceIds: ["tenant-a"] });
    expect(JSON.stringify(own)).toContain("b");
    const other = await runRecursiveWalk(storage.engine(), "Svc::a", { direction: "callees", exact: true, sourceIds: ["tenant-b"] });
    expect(JSON.stringify(other)).not.toContain("Svc::b");
  });

  it("keeps an edge with no source out of a scoped structural expansion", async () => {
    const chunks = await storage.engine().query<{ id: string; symbol_name: string }>(
      `SELECT id, symbol_name FROM chunks WHERE document_id = $1`,
      [documentId],
    );
    const a = chunks.rows.find((row) => row.symbol_name === "a")!.id;
    const b = chunks.rows.find((row) => row.symbol_name === "b")!.id;
    await storage.engine().query(`UPDATE code_edges_symbol SET source_id = NULL WHERE from_chunk_id = $1`, [a]);
    try {
      const out = await expandAnchors(storage.engine(), [{ id: a, score: 1 }], { walkDepth: 1, sourceIds: ["tenant-b"] });
      expect(out.some((x) => x.id === b)).toBe(false);
    } finally {
      await storage.engine().query(`UPDATE code_edges_symbol SET source_id = 'tenant-a' WHERE from_chunk_id = $1`, [a]);
    }
  });
});

describe("a document that gets its source later", () => {
  it("hands the source on to its chunks and code edges", async () => {
    const src = ["export class Late {", "  x() { return this.y(); }", "  y() { return 2; }", "}"].join("\n");
    // mtimeMs stands in for the file indexer's stamp: the backfill classifies
    // only documents of local provenance.
    const r = await indexCodeDocument(storage, { sourcePath: "/tenant-b/late.ts", text: src, mtimeMs: 1 });
    const before = await storage.engine().query<{ source_id: string | null }>(
      `SELECT DISTINCT e.source_id FROM code_edges_symbol e JOIN chunks c ON c.id = e.from_chunk_id WHERE c.document_id = $1`,
      [r.documentId],
    );
    expect(before.rows.map((row) => row.source_id)).toEqual([null]);
    await backfillDocumentSources(storage.engine(), ["/tenant-b/late.ts"]);
    const edges = await storage.engine().query<{ source_id: string | null }>(
      `SELECT DISTINCT e.source_id FROM code_edges_symbol e JOIN chunks c ON c.id = e.from_chunk_id WHERE c.document_id = $1`,
      [r.documentId],
    );
    expect(edges.rows.map((row) => row.source_id)).toEqual(["tenant-b"]);
    const chunks = await storage.engine().query<{ source_id: string | null }>(
      `SELECT DISTINCT source_id FROM chunks WHERE document_id = $1`,
      [r.documentId],
    );
    expect(chunks.rows.map((row) => row.source_id)).toEqual(["tenant-b"]);
  });
});

describe("volunteer events carry their page's source", () => {
  it("stamps the page source and scopes the usage stats to it", async () => {
    await putPage(storage, { slug: "notes/vol-a", type: "note", title: "A", markdown_body: "a", source_id: "tenant-a" });
    await putPage(storage, { slug: "notes/vol-b", type: "note", title: "B", markdown_body: "b", source_id: "tenant-b" });
    await insertVolunteerEvents(storage, [
      { slug: "notes/vol-a", confidence: 1, match_arm: "title", rationale: "r", channel: "op" },
      { slug: "notes/vol-b", confidence: 1, match_arm: "alias", rationale: "r", channel: "op" },
    ]);
    const rows = await storage.engine().query<{ slug: string; source_id: string | null }>(
      `SELECT slug, source_id FROM context_volunteer_events ORDER BY slug`,
    );
    expect(rows.rows).toEqual([
      { slug: "notes/vol-a", source_id: "tenant-a" },
      { slug: "notes/vol-b", source_id: "tenant-b" },
    ]);
    const scoped = await volunteerUsageStats(storage, 30, ["tenant-a"]);
    expect(scoped.total_volunteered).toBe(1);
    expect(scoped.by_arm.map((arm) => arm.match_arm)).toEqual(["title"]);
    expect((await volunteerUsageStats(storage, 30, [])).total_volunteered).toBe(0);
    expect((await volunteerUsageStats(storage, 30)).total_volunteered).toBe(2);
  });
});
