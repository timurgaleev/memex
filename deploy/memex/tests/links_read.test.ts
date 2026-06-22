/**
 * Links read-side — getLinks (both directions, grouped by type) +
 * listLinkSources (KNOWN_LINK_TYPES catalogue with per-type edge counts).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { putPage } from "../src/core/pages.ts";
import { addLink, KNOWN_LINK_TYPES } from "../src/core/links.ts";
import { getLinks, listLinkSources } from "../src/core/links-read.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-links-read-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  // Source pages must exist (FK on links.source_slug).
  await putPage(storage, { slug: "people/alice", type: "person" });
  await putPage(storage, { slug: "people/bob", type: "person" });
  await putPage(storage, { slug: "companies/acme", type: "company" });
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("getLinks", () => {
  it("groups edges by type and direction for a slug", async () => {
    // alice → acme (works_at, outbound from alice)
    await addLink(storage, {
      source_slug: "people/alice",
      target_slug: "companies/acme",
      type: "works_at",
    });
    // bob → alice (knows, inbound to alice)
    await addLink(storage, {
      source_slug: "people/bob",
      target_slug: "people/alice",
      type: "knows",
    });

    const groups = await getLinks(storage, "people/alice");
    expect(groups.length).toBe(2);

    const works = groups.find(
      (g) => g.type === "works_at" && g.direction === "outbound",
    );
    expect(works?.links.map((l) => l.target_slug)).toEqual(["companies/acme"]);

    const knows = groups.find(
      (g) => g.type === "knows" && g.direction === "inbound",
    );
    expect(knows?.links.map((l) => l.source_slug)).toEqual(["people/bob"]);
  });

  it("returns empty for a slug with no edges", async () => {
    expect(await getLinks(storage, "people/bob")).toEqual([]);
  });

  it("orders groups by type then outbound-before-inbound", async () => {
    // A self-referencing pair so the same type appears in both directions.
    await addLink(storage, {
      source_slug: "people/alice",
      target_slug: "people/bob",
      type: "knows",
    });
    await addLink(storage, {
      source_slug: "people/bob",
      target_slug: "people/alice",
      type: "knows",
    });
    await addLink(storage, {
      source_slug: "people/alice",
      target_slug: "companies/acme",
      type: "works_at",
    });

    const groups = await getLinks(storage, "people/alice");
    expect(groups.map((g) => `${g.type}/${g.direction}`)).toEqual([
      "knows/inbound",
      "knows/outbound",
      "works_at/outbound",
    ]);
  });

  it("links within a group are newest-first", async () => {
    await addLink(storage, {
      source_slug: "people/alice",
      target_slug: "companies/acme",
      type: "mentions",
    });
    await addLink(storage, {
      source_slug: "people/alice",
      target_slug: "people/bob",
      type: "mentions",
    });
    const groups = await getLinks(storage, "people/alice");
    const mentions = groups.find((g) => g.type === "mentions");
    expect(mentions?.links.length).toBe(2);
    const [first, second] = mentions!.links;
    expect(
      new Date(first!.written_at).getTime() >=
        new Date(second!.written_at).getTime(),
    ).toBe(true);
  });

  it("rejects an invalid slug", async () => {
    await expect(getLinks(storage, "Not A Slug")).rejects.toThrow();
  });
});

describe("listLinkSources", () => {
  it("returns the full catalogue with zero counts on an empty graph", async () => {
    const sources = await listLinkSources(storage);
    expect(sources.length).toBe(KNOWN_LINK_TYPES.length);
    expect(sources.every((s) => s.count === 0 && s.known)).toBe(true);
    // All KNOWN_LINK_TYPES present.
    expect(new Set(sources.map((s) => s.type))).toEqual(
      new Set(KNOWN_LINK_TYPES),
    );
  });

  it("counts live edges per type, most-used first", async () => {
    await addLink(storage, {
      source_slug: "people/alice",
      target_slug: "people/bob",
      type: "knows",
    });
    await addLink(storage, {
      source_slug: "people/bob",
      target_slug: "people/alice",
      type: "knows",
    });
    await addLink(storage, {
      source_slug: "people/alice",
      target_slug: "companies/acme",
      type: "works_at",
    });

    const sources = await listLinkSources(storage);
    const knows = sources.find((s) => s.type === "knows");
    const works = sources.find((s) => s.type === "works_at");
    expect(knows?.count).toBe(2);
    expect(works?.count).toBe(1);
    // knows (2) sorts before works_at (1).
    const knowsIdx = sources.findIndex((s) => s.type === "knows");
    const worksIdx = sources.findIndex((s) => s.type === "works_at");
    expect(knowsIdx).toBeLessThan(worksIdx);
  });

  it("surfaces an ad-hoc type as known:false", async () => {
    await addLink(storage, {
      source_slug: "people/alice",
      target_slug: "companies/acme",
      type: "custom_rel",
      allowAdHocType: true,
    });
    const sources = await listLinkSources(storage);
    const custom = sources.find((s) => s.type === "custom_rel");
    expect(custom).toBeDefined();
    expect(custom?.known).toBe(false);
    expect(custom?.count).toBe(1);
    // Catalogue + 1 ad-hoc type.
    expect(sources.length).toBe(KNOWN_LINK_TYPES.length + 1);
  });
});
