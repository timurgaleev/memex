/**
 * Generation clock — cache-invalidation substrate tests (migration 022).
 *
 * Fresh PGLite-backed Storage per test — no Bedrock, no HTTP. Verifies the
 * per-page `generation` column and the global `page_generation_clock`
 * singleton bump on create / change / append / delete, and that an
 * idempotent put does NOT bump.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { appendPage, deletePage, putPage } from "../src/core/pages.ts";
import { currentClock } from "../src/core/generation.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-generation-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function pageGen(slug: string): Promise<number> {
  const r = await storage
    .engine()
    .query<{ generation: number }>(
      `SELECT generation FROM pages WHERE slug = $1`,
      [slug],
    );
  return Number(r.rows[0]!.generation);
}

describe("generation clock", () => {
  it("starts the clock at 0 with a singleton row", async () => {
    expect(await currentClock(storage.engine())).toBe(0);
  });

  it("bumps page generation + global clock on create", async () => {
    await putPage(storage, {
      slug: "ideas/a",
      type: "idea",
      markdown_body: "v1",
    });
    expect(await pageGen("ideas/a")).toBe(1);
    expect(await currentClock(storage.engine())).toBe(1);
  });

  it("bumps on a content change but not on an idempotent put", async () => {
    await putPage(storage, {
      slug: "ideas/a",
      type: "idea",
      markdown_body: "v1",
    });
    // idempotent — same body/type/title/truth — must NOT bump.
    await putPage(storage, {
      slug: "ideas/a",
      type: "idea",
      markdown_body: "v1",
    });
    expect(await pageGen("ideas/a")).toBe(1);
    expect(await currentClock(storage.engine())).toBe(1);
    // real change — must bump.
    await putPage(storage, {
      slug: "ideas/a",
      type: "idea",
      markdown_body: "v2",
    });
    expect(await pageGen("ideas/a")).toBe(2);
    expect(await currentClock(storage.engine())).toBe(2);
  });

  it("bumps on append and on delete", async () => {
    await putPage(storage, {
      slug: "ideas/a",
      type: "idea",
      markdown_body: "v1",
    });
    const afterCreate = await currentClock(storage.engine());
    await appendPage(storage, { slug: "ideas/a", content: "more" });
    expect(await currentClock(storage.engine())).toBe(afterCreate + 1);
    await deletePage(storage, "ideas/a");
    expect(await currentClock(storage.engine())).toBe(afterCreate + 2);
  });
});
