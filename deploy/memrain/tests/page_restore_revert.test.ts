/**
 * page_restore (undelete) + page_revert (roll back to a version snapshot).
 * Core-level, offline (page CRUD doesn't embed).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import {
  putPage,
  deletePage,
  restorePage,
  revertPage,
  getPage,
} from "../src/core/pages.ts";

let tmp: string;
let storage: Storage;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-restore-revert-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("restorePage", () => {
  it("undeletes a soft-deleted page", async () => {
    const slug = "notes/restore-me";
    await putPage(storage, { slug, type: "note", title: "R", markdown_body: "alpha" });
    await deletePage(storage, slug);
    expect(await getPage(storage, slug)).toBeNull(); // soft-deleted → hidden

    const r = await restorePage(storage, slug);
    expect(r.restored).toBe(true);
    const page = await getPage(storage, slug);
    expect(page).not.toBeNull();
    expect(page!.markdown_body).toBe("alpha"); // body preserved through delete→restore
  });

  it("is a no-op on a live page and on a missing page", async () => {
    const slug = "notes/live";
    await putPage(storage, { slug, type: "note", title: "L", markdown_body: "x" });
    expect((await restorePage(storage, slug)).restored).toBe(false); // already live
    expect((await restorePage(storage, "notes/does-not-exist")).restored).toBe(false);
  });
});

describe("revertPage", () => {
  it("rolls the body back to a prior version, creating a new version", async () => {
    const slug = "notes/revert-me";
    const v1 = await putPage(storage, { slug, type: "note", title: "Rv", markdown_body: "first body" });
    await putPage(storage, { slug, type: "note", title: "Rv", markdown_body: "second body" });
    expect((await getPage(storage, slug))!.markdown_body).toBe("second body");

    const r = await revertPage(storage, slug, v1.version_n);
    expect(r.reverted).toBe(true);
    expect(r.from_version).toBe(v1.version_n);
    expect(r.new_version).toBeGreaterThan(v1.version_n);
    const after = await getPage(storage, slug);
    expect(after!.markdown_body).toBe("first body");
    expect(after!.title).toBe("Rv"); // title preserved through revert (not nulled)

    // Reverting again to the now-current body is a no-op (idempotent).
    const again = await revertPage(storage, slug, v1.version_n);
    expect(again.reverted).toBe(false);
    expect(again.new_version).toBeNull();
    expect((await getPage(storage, slug))!.title).toBe("Rv"); // still intact
  });

  it("refuses to revert to a delete/restore event version", async () => {
    const slug = "notes/revert-tombstone";
    await putPage(storage, { slug, type: "note", title: "T", markdown_body: "body" });
    await deletePage(storage, slug); // appends a tombstone version
    await restorePage(storage, slug);
    // Find the tombstone version number: it's the delete event (version 2 here).
    const r = await revertPage(storage, slug, 2);
    expect(r.reverted).toBe(false);
    expect(r.reason).toContain("event");
  });

  it("returns reverted:false for a missing version or a deleted page", async () => {
    const slug = "notes/revert-missing";
    await putPage(storage, { slug, type: "note", title: "M", markdown_body: "b" });
    expect((await revertPage(storage, slug, 999)).reverted).toBe(false);
    await deletePage(storage, slug);
    expect((await revertPage(storage, slug, 1)).reverted).toBe(false); // deleted → guarded
  });
});
