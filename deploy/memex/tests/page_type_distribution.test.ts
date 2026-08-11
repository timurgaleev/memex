/**
 * `stats` reports how the corpus is typed.
 *
 * page_put permits an ad-hoc type and the brain's own writers use several that
 * are not declared, so a typo (`peson`) or a writer drifting to a new label was
 * invisible until someone noticed a page missing from a type-filtered read.
 * This counts; it never rejects.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { putPage } from "../src/core/pages.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-types-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function stats(): Promise<Record<string, unknown>> {
  const r = await dispatchTool(storage, { name: "stats", arguments: {} });
  return JSON.parse((r.content[0] as { text: string }).text);
}

describe("stats.page_types", () => {
  it("breaks the corpus down by type, commonest first", async () => {
    await putPage(storage, { slug: "people/alice", type: "person" });
    await putPage(storage, { slug: "people/bob", type: "person" });
    await putPage(storage, { slug: "notes/a", type: "note" });

    const s = await stats();
    const dist = s.page_types as { by_type: { type: string; count: number }[] };
    expect(dist.by_type[0]).toEqual({ type: "person", count: 2 });
    expect(dist.by_type).toContainEqual({ type: "note", count: 1 });
  });

  it("names the types nobody declared, which is where a typo shows up", async () => {
    await putPage(storage, { slug: "people/alice", type: "person" });
    await putPage(storage, { slug: "people/carol", type: "peson", allowAdHocType: true });

    const s = await stats();
    const dist = s.page_types as { unknown_types: string[]; unknown_pages: number };
    expect(dist.unknown_types).toEqual(["peson"]);
    expect(dist.unknown_pages).toBe(1);
  });

  it("counts nothing as unknown when every page is a declared type", async () => {
    await putPage(storage, { slug: "people/alice", type: "person" });
    const s = await stats();
    const dist = s.page_types as { unknown_types: string[]; unknown_pages: number };
    expect(dist.unknown_types).toEqual([]);
    expect(dist.unknown_pages).toBe(0);
  });

  it("ignores soft-deleted pages", async () => {
    await putPage(storage, { slug: "notes/gone", type: "note" });
    await storage
      .engine()
      .exec(`UPDATE pages SET deleted_at = now() WHERE slug = 'notes/gone'`);
    const s = await stats();
    const dist = s.page_types as { by_type: { type: string; count: number }[] };
    expect(dist.by_type).toEqual([]);
  });
});
