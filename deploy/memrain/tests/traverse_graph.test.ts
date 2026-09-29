/**
 * traverseGraph — recursive N-hop walk over the link graph. Offline (PGLite).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { addLink, traverseGraph } from "../src/core/links.ts";
import { putPage } from "../src/core/pages.ts";

let tmp: string;
let storage: Storage;

const link = (s: string, t: string, type = "knows") =>
  addLink(storage, { source_slug: s, target_slug: t, type, allowAdHocType: true });

const depthOf = (hits: { slug: string; depth: number }[], slug: string) =>
  hits.find((h) => h.slug === slug)?.depth;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-traverse-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  // links.source_slug has a FK to pages(slug) — create every node first.
  for (const s of ["people/a", "people/b", "people/c", "people/d", "people/e", "people/x", "co/f"]) {
    await putPage(storage, { slug: s, type: s.startsWith("co/") ? "company" : "person", title: s, markdown_body: "x" });
  }
  // Chain a→b→c→d, branch a→x, inbound e→a, typed a→f (founded), cycle d→a.
  await link("people/a", "people/b");
  await link("people/b", "people/c");
  await link("people/c", "people/d");
  await link("people/a", "people/x");
  await link("people/e", "people/a");
  await link("people/a", "co/f", "founded");
  await link("people/d", "people/a"); // cycle back to start
});

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("traverseGraph", () => {
  it("walks outbound to maxDepth, reporting shortest depth", async () => {
    const hits = await traverseGraph(storage, "people/a", { direction: "outbound", maxDepth: 2 });
    expect(depthOf(hits, "people/b")).toBe(1);
    expect(depthOf(hits, "people/x")).toBe(1);
    expect(depthOf(hits, "people/c")).toBe(2);
    expect(depthOf(hits, "people/d")).toBeUndefined(); // depth 3 > maxDepth 2
    expect(depthOf(hits, "people/a")).toBeUndefined(); // start excluded
  });

  it("reaches deeper nodes at higher maxDepth and terminates on a cycle", async () => {
    const hits = await traverseGraph(storage, "people/a", { direction: "outbound", maxDepth: 10 });
    expect(depthOf(hits, "people/d")).toBe(3);
    expect(depthOf(hits, "people/a")).toBeUndefined(); // cycle d→a never re-enters start
  });

  it("follows inbound + both directions", async () => {
    const both = await traverseGraph(storage, "people/a", { direction: "both", maxDepth: 1 });
    expect(depthOf(both, "people/b")).toBe(1); // outbound edge
    expect(depthOf(both, "people/e")).toBe(1); // inbound edge
    const inbound = await traverseGraph(storage, "people/a", { direction: "inbound", maxDepth: 1 });
    expect(depthOf(inbound, "people/e")).toBe(1);
    expect(depthOf(inbound, "people/b")).toBeUndefined();
  });

  it("filters by edge type", async () => {
    const knows = await traverseGraph(storage, "people/a", { direction: "outbound", type: "knows", maxDepth: 1 });
    expect(depthOf(knows, "people/b")).toBe(1);
    expect(depthOf(knows, "co/f")).toBeUndefined(); // founded edge excluded
    const founded = await traverseGraph(storage, "people/a", { direction: "outbound", type: "founded", maxDepth: 1 });
    expect(depthOf(founded, "co/f")).toBe(1);
  });

  it("rejects a bad direction", async () => {
    await expect(
      traverseGraph(storage, "people/a", { direction: "sideways" as never }),
    ).rejects.toThrow(/direction/);
  });
});
