/**
 * Page rename primitive (Item 2) — carries substrate across a new slug within
 * the global-slug-PK model and leaves a durable redirect. PGLite-backed.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { appendPage, getPage, putPage, renamePage, pageVersions } from "../src/core/pages.ts";
import { addLink, graphNeighbors } from "../src/core/links.ts";
import { addTag, getTags } from "../src/core/tags.ts";
import { resolveSlugWithAlias } from "../src/core/slug-aliases.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-rename-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("renamePage", () => {
  it("moves the page, carries versions/links/tags, and leaves a redirect", async () => {
    await putPage(storage, { slug: "people/bob", type: "person", title: "Bob", markdown_body: "v1" });
    await putPage(storage, { slug: "people/bob", type: "person", title: "Bob", markdown_body: "v2" });
    await putPage(storage, { slug: "companies/acme", type: "company" });
    // Outbound + inbound edges + a tag.
    await addLink(storage, { source_slug: "people/bob", target_slug: "companies/acme", type: "works_at" });
    await addLink(storage, { source_slug: "companies/acme", target_slug: "people/bob", type: "mentions" });
    await addTag(storage, "people/bob", "vip");

    const r = await renamePage(storage, "people/bob", "people/robert");
    expect(r.renamed).toBe(true);

    // Old slug is gone as an exact row but resolves through the redirect.
    const viaRedirect = await getPage(storage, "people/bob");
    expect(viaRedirect?.slug).toBe("people/robert");
    expect(await resolveSlugWithAlias(storage, "people/bob")).toBe("people/robert");

    // New page carries body + title + version history (+1 rename marker).
    const page = await getPage(storage, "people/robert");
    expect(page?.markdown_body).toBe("v2");
    expect(page?.title).toBe("Bob");
    const versions = await pageVersions(storage, "people/robert", 50);
    expect(versions.length).toBeGreaterThanOrEqual(3); // v1, v2, rename marker

    // Tag carried.
    expect(await getTags(storage, "people/robert")).toContain("vip");

    // Outbound edge carried (robert -> acme).
    const out = await graphNeighbors(storage, "people/robert", { direction: "outbound" });
    expect(out.some((l) => (l as { target_slug: string }).target_slug === "companies/acme")).toBe(true);

    // Inbound edge re-pointed (acme -> robert).
    const acmeOut = await graphNeighbors(storage, "companies/acme", { direction: "outbound" });
    expect(acmeOut.some((l) => (l as { target_slug: string }).target_slug === "people/robert")).toBe(true);
  });

  it("is a no-op when the target slug already exists", async () => {
    await putPage(storage, { slug: "a", type: "note" });
    await putPage(storage, { slug: "b", type: "note" });
    const r = await renamePage(storage, "a", "b");
    expect(r.renamed).toBe(false);
    expect(r.reason).toMatch(/already exists/);
    // Both pages intact.
    expect((await getPage(storage, "a"))?.slug).toBe("a");
    expect((await getPage(storage, "b"))?.slug).toBe("b");
  });

  it("is a no-op when the source page is missing", async () => {
    const r = await renamePage(storage, "ghost", "somewhere");
    expect(r.renamed).toBe(false);
    expect(r.reason).toMatch(/not found/);
  });

  it("refuses to rename across tenants (scoped source)", async () => {
    // pages.source_id FKs -> sources (migration 047); register the tenant first.
    await storage.engine().query(
      "INSERT INTO sources (id, kind, path_prefix) VALUES ($1, 'other', $2) ON CONFLICT (id) DO NOTHING",
      ["tenant-a", "__tenant-a__"],
    );
    await putPage(storage, { slug: "x", type: "note", source_id: "tenant-a" });
    // Caller scoped to tenant-b cannot see (or move) tenant-a's page.
    const r = await renamePage(storage, "x", "y", { source_id: "tenant-b" });
    expect(r.renamed).toBe(false);
    // The page is untouched under tenant-a.
    expect((await getPage(storage, "x", ["tenant-a"]))?.slug).toBe("x");
  });

  it("does not resurrect a renamed-away slug via append (writes ignore redirects)", async () => {
    await putPage(storage, { slug: "people/bob", type: "person", markdown_body: "hi" });
    await renamePage(storage, "people/bob", "people/robert");
    // Append to the OLD slug must fail — it only holds a redirect now, not a page.
    await expect(
      appendPage(storage, { slug: "people/bob", content: "more" }),
    ).rejects.toThrow(/does not exist/);
    // And the old slug was NOT recreated as a live page row.
    const canonical = await getPage(storage, "people/robert");
    expect(canonical?.markdown_body).toBe("hi"); // unchanged, no stray append
  });

  it("collapses a double rename into one redirect hop", async () => {
    await putPage(storage, { slug: "n1", type: "note" });
    await renamePage(storage, "n1", "n2");
    await renamePage(storage, "n2", "n3");
    // n1 forwards straight to n3, not to the intermediate n2.
    expect(await resolveSlugWithAlias(storage, "n1")).toBe("n3");
    expect((await getPage(storage, "n1"))?.slug).toBe("n3");
  });
});
