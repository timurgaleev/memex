/**
 * Page write integrity. A put that omitted the body blanked a populated page; an
 * explicit empty body did the same silently; and `page_append` read the page
 * outside the write transaction, so two appends racing each other both started
 * from the same body and one of them was lost.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { appendPage, getPage, putPage, revertPage } from "../src/core/pages.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-write-integrity-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});
afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("a put never blanks a page by accident", () => {
  it("keeps the body when a put omits it", async () => {
    await putPage(storage, { slug: "notes/keep", title: "Old", markdown_body: "the body stays" });
    await putPage(storage, { slug: "notes/keep", title: "New title" });
    const page = await getPage(storage, "notes/keep");
    expect(page?.title).toBe("New title");
    expect(page?.markdown_body).toBe("the body stays");
  });

  it("refuses an explicit empty body over a populated page", async () => {
    await putPage(storage, { slug: "notes/full", markdown_body: "something worth keeping" });
    await expect(putPage(storage, { slug: "notes/full", markdown_body: "" })).rejects.toMatchObject({
      code: "invalid_params",
    });
    expect((await getPage(storage, "notes/full"))?.markdown_body).toBe("something worth keeping");
  });

  it("empties a page when the caller says so", async () => {
    await putPage(storage, { slug: "notes/clear", markdown_body: "to be cleared" });
    await putPage(storage, { slug: "notes/clear", markdown_body: "", allowEmptyBody: true });
    expect((await getPage(storage, "notes/clear"))?.markdown_body).toBe("");
  });

  it("still creates a page with no body", async () => {
    const r = await putPage(storage, { slug: "notes/new-empty", title: "Just a title" });
    expect(r.created).toBe(true);
  });
});

describe("concurrent appends", () => {
  it("keeps every one of ten racing appends, with unique versions", async () => {
    await putPage(storage, { slug: "notes/log", markdown_body: "start" });
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => appendPage(storage, { slug: "notes/log", content: `line ${i}` })),
    );
    const body = (await getPage(storage, "notes/log"))!.markdown_body;
    for (let i = 0; i < 10; i++) expect(body).toContain(`line ${i}`);
    const versions = await storage.engine().query<{ n: number; distinct_n: number; top: number }>(
      `SELECT count(*)::int AS n, count(DISTINCT version_n)::int AS distinct_n, max(version_n)::int AS top
         FROM page_versions WHERE slug = 'notes/log'`,
    );
    expect(versions.rows[0]).toEqual({ n: 11, distinct_n: 11, top: 11 });
  });

  it("does not revert a title edit that landed between the append's read and its write", async () => {
    await putPage(storage, { slug: "notes/titled", title: "First", markdown_body: "body" });
    // Interleave: the append and a title change race; whichever order the
    // writes take, the final page carries the new title AND the appended line.
    await Promise.all([
      appendPage(storage, { slug: "notes/titled", content: "appended" }),
      putPage(storage, { slug: "notes/titled", title: "Second" }),
    ]);
    const page = (await getPage(storage, "notes/titled"))!;
    expect(page.title).toBe("Second");
    expect(page.markdown_body).toContain("appended");
  });
});

describe("the edges of the empty-body rule", () => {
  it("lets a revert go back to an empty first version", async () => {
    await putPage(storage, { slug: "notes/was-empty", title: "Started blank" });
    await putPage(storage, { slug: "notes/was-empty", markdown_body: "filled in later" });
    const r = await revertPage(storage, "notes/was-empty", 1);
    expect(r.reverted).toBe(true);
    expect((await getPage(storage, "notes/was-empty"))?.markdown_body).toBe("");
  });

  it("accepts allow_empty_body through page_put", async () => {
    await putPage(storage, { slug: "notes/via-mcp", markdown_body: "to clear" });
    const refused = await dispatchTool(storage, {
      name: "page_put",
      arguments: { slug: "notes/via-mcp", markdown_body: "" },
    });
    expect(refused.isError).toBe(true);
    const cleared = await dispatchTool(storage, {
      name: "page_put",
      arguments: { slug: "notes/via-mcp", markdown_body: "", allow_empty_body: true },
    });
    expect(cleared.isError ?? false).toBe(false);
    expect((await getPage(storage, "notes/via-mcp"))?.markdown_body).toBe("");
  });

  it("keeps the old body when a deleted page is brought back without one", async () => {
    await putPage(storage, { slug: "notes/back", markdown_body: "kept through the delete" });
    await dispatchTool(storage, { name: "page_delete", arguments: { slug: "notes/back" } });
    await putPage(storage, { slug: "notes/back", title: "Back again" });
    const page = await getPage(storage, "notes/back");
    expect(page?.deleted_at).toBeNull();
    expect(page?.markdown_body).toBe("kept through the delete");
  });
});
