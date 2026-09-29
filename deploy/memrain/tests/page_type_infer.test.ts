/**
 * Slug-based page-type inference (#64) — `inferPageType` + putPage inferring
 * `type` from the slug convention when omitted.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { putPage, getPage, inferPageType } from "../src/core/pages.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-ptype-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});
afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("inferPageType", () => {
  it("maps known slug prefixes to a type", () => {
    expect(inferPageType("people/alice")).toBe("person");
    expect(inferPageType("companies/acme")).toBe("company");
    expect(inferPageType("meetings/2026-01")).toBe("meeting");
    expect(inferPageType("journal/2026/05/x")).toBe("journal");
    expect(inferPageType("ideas/inbox/x")).toBe("idea");
  });
  it("is null for an unknown prefix", () => {
    expect(inferPageType("random/thing")).toBeNull();
    expect(inferPageType("toplevel")).toBeNull();
  });
});

describe("putPage type inference", () => {
  it("infers type from the slug when omitted", async () => {
    await putPage(storage, { slug: "people/bob" });
    expect((await getPage(storage, "people/bob"))!.type).toBe("person");
  });
  it("defaults to note for an unknown prefix", async () => {
    await putPage(storage, { slug: "random/x" });
    expect((await getPage(storage, "random/x"))!.type).toBe("note");
  });
  it("an explicit type always wins over inference", async () => {
    await putPage(storage, { slug: "people/carol", type: "company" });
    expect((await getPage(storage, "people/carol"))!.type).toBe("company");
  });

  it("an omitted-type re-put PRESERVES the existing type (no re-inference)", async () => {
    // top-level page typed explicitly, then re-put without a type
    await putPage(storage, { slug: "alice", type: "person", markdown_body: "v1" });
    await putPage(storage, { slug: "alice", markdown_body: "v2" });
    expect((await getPage(storage, "alice"))!.type).toBe("person");

    // prefix/type mismatch: people/ slug typed company, re-put without type
    await putPage(storage, { slug: "people/acme", type: "company", markdown_body: "v1" });
    await putPage(storage, { slug: "people/acme", markdown_body: "v2" });
    expect((await getPage(storage, "people/acme"))!.type).toBe("company");

    // ad-hoc existing type survives an omitted-type re-put
    await putPage(storage, { slug: "x/y", type: "widget", allowAdHocType: true, markdown_body: "v1" });
    await putPage(storage, { slug: "x/y", markdown_body: "v2" });
    expect((await getPage(storage, "x/y"))!.type).toBe("widget");
  });
});
