/**
 * Public-ingress redaction for graph reads.
 *
 * `graph_neighbors` / `graph_query` are readable under the public bearer,
 * but on public ingress the response must keep only slugs + the edge type
 * and DROP the relationship-provenance bundle (`source_chunk_id`,
 * `written_at`), the raw confidence signal, and the internal row `id`.
 * Internal ingress keeps the full row. Surfaced by the 2026-06-09
 * cross-model audit (independent reviewers + the reference parity diff).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { dispatchTool, type ToolCallResult } from "../src/mcp/dispatch.ts";
import { addLink } from "../src/core/links.ts";
import { putPage } from "../src/core/pages.ts";

const dir = mkdtempSync(join(tmpdir(), "tb-graph-redact-"));
let storage: Storage;

const PROVENANCE = ["source_chunk_id", "written_at", "inferred_confidence", "id"];

function parse(r: ToolCallResult): { ok: boolean; links: Record<string, unknown>[] } {
  return JSON.parse((r.content[0] as { text: string }).text);
}

beforeAll(async () => {
  storage = new Storage({ dbPath: dir });
  await storage.init();
  await putPage(storage, { slug: "people/alice", type: "person", title: "Alice", allowAdHocType: true });
  await putPage(storage, { slug: "companies/acme", type: "company", title: "Acme", allowAdHocType: true });
  await addLink(storage, {
    source_slug: "people/alice",
    target_slug: "companies/acme",
    type: "works_at",
    confidence: 0.9,
    source_chunk_id: "chunk-secret-provenance",
  });
});

afterAll(async () => {
  await storage.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("graph_query redaction", () => {
  const args = { type: "works_at", target_slug: "companies/acme" };

  it("drops provenance on public ingress, keeps slugs + type", async () => {
    const out = parse(await dispatchTool(storage, { name: "graph_query", arguments: args }, { isPublic: true }));
    expect(out.links.length).toBe(1);
    const link = out.links[0]!;
    expect(link["source_slug"]).toBe("people/alice");
    expect(link["target_slug"]).toBe("companies/acme");
    expect(link["type"]).toBe("works_at");
    for (const f of PROVENANCE) expect(link[f]).toBeUndefined();
    // The secret provenance value must not appear anywhere in the payload.
    expect(JSON.stringify(out)).not.toContain("chunk-secret-provenance");
  });

  it("keeps the full row on internal ingress", async () => {
    const out = parse(await dispatchTool(storage, { name: "graph_query", arguments: args }, { isPublic: false }));
    const link = out.links[0]!;
    expect(link["source_chunk_id"]).toBe("chunk-secret-provenance");
    expect(link["written_at"]).toBeDefined();
    expect(link["inferred_confidence"]).toBe(0.9);
  });
});

describe("graph_neighbors redaction", () => {
  const args = { slug: "people/alice" };

  it("drops provenance on public, keeps slugs + type + direction", async () => {
    const out = parse(await dispatchTool(storage, { name: "graph_neighbors", arguments: args }, { isPublic: true }));
    expect(out.links.length).toBeGreaterThan(0);
    const link = out.links[0]!;
    expect(link["source_slug"]).toBeDefined();
    expect(link["type"]).toBe("works_at");
    expect(link["direction"]).toBeDefined(); // traversal hint stays
    for (const f of PROVENANCE) expect(link[f]).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain("chunk-secret-provenance");
  });

  it("keeps the full row on internal ingress", async () => {
    const out = parse(await dispatchTool(storage, { name: "graph_neighbors", arguments: args }, { isPublic: false }));
    const link = out.links[0]!;
    expect(link["source_chunk_id"]).toBe("chunk-secret-provenance");
    expect(link["inferred_confidence"]).toBe(0.9);
  });
});

describe("graph provenance redaction is independent of MEMEX_PUBLIC_READ_BODIES", () => {
  // Provenance is structural metadata, not a note body — opting into public
  // bodies must NOT re-expose source_chunk_id/written_at/confidence on graph.
  it("still strips provenance on public even when READ_BODIES=1", async () => {
    const prev = process.env["MEMEX_PUBLIC_READ_BODIES"];
    process.env["MEMEX_PUBLIC_READ_BODIES"] = "1";
    try {
      const out = parse(await dispatchTool(
        storage,
        { name: "graph_query", arguments: { type: "works_at", target_slug: "companies/acme" } },
        { isPublic: true },
      ));
      const link = out.links[0]!;
      expect(link["source_slug"]).toBe("people/alice");
      expect(link["type"]).toBe("works_at");
      for (const f of PROVENANCE) expect(link[f]).toBeUndefined();
      expect(JSON.stringify(out)).not.toContain("chunk-secret-provenance");
    } finally {
      if (prev === undefined) delete process.env["MEMEX_PUBLIC_READ_BODIES"];
      else process.env["MEMEX_PUBLIC_READ_BODIES"] = prev;
    }
  });
});
