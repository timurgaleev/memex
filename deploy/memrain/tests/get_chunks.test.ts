/**
 * get_chunks tests — seed documents + chunks directly (no Bedrock, no embeds)
 * and verify chunks come back ordered by chunk_index for both a page slug
 * (resolved through the `page://<slug>` mirror) and a raw source_path.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import {
  getChunksForPage,
  getChunksForSource,
} from "../src/core/chunks-read.ts";
import { pageSourcePath } from "../src/core/page-index.ts";

let tmp: string;
let storage: Storage;

async function seed() {
  const db = storage.engine();
  // A page mirror document (page://demo) with three chunks inserted
  // out of order, plus a plain file document with code-symbol chunks.
  await db.exec(`
    INSERT INTO documents (id, source_path, title) VALUES
      ('pd', 'page://demo', 'Demo page'),
      ('fd', '/vault/code.ts', 'Code file');
    INSERT INTO chunks (id, document_id, chunk_index, content, symbol_name) VALUES
      ('pd2', 'pd', 2, 'third paragraph', NULL),
      ('pd0', 'pd', 0, 'first paragraph', NULL),
      ('pd1', 'pd', 1, 'second paragraph', NULL),
      ('fd0', 'fd', 0, 'function alpha() {}', 'alpha'),
      ('fd1', 'fd', 1, 'function beta() {}', 'beta');
  `);
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-getchunks-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  await seed();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("getChunksForPage", () => {
  it("resolves the slug to its page:// mirror and returns chunks in order", async () => {
    const r = await getChunksForPage(storage, "demo");
    expect(r.map((c) => c.chunkIndex)).toEqual([0, 1, 2]);
    expect(r.map((c) => c.content)).toEqual([
      "first paragraph",
      "second paragraph",
      "third paragraph",
    ]);
    expect(r[0]!.chunkId).toBe("pd0");
    expect(r.every((c) => c.symbolName === null)).toBe(true);
  });

  it("returns [] for an unknown slug", async () => {
    expect(await getChunksForPage(storage, "no-such-page")).toEqual([]);
  });

  it("rejects an empty slug", async () => {
    await expect(getChunksForPage(storage, "")).rejects.toThrow(/slug/);
  });
});

describe("getChunksForSource", () => {
  it("returns a raw document's chunks in order with symbol names", async () => {
    const r = await getChunksForSource(storage, "/vault/code.ts");
    expect(r.map((c) => c.chunkIndex)).toEqual([0, 1]);
    expect(r.map((c) => c.symbolName)).toEqual(["alpha", "beta"]);
  });

  it("matches the page mirror source_path built by pageSourcePath", async () => {
    const viaSource = await getChunksForSource(storage, pageSourcePath("demo"));
    const viaSlug = await getChunksForPage(storage, "demo");
    expect(viaSource).toEqual(viaSlug);
  });

  it("returns [] for an unknown source_path", async () => {
    expect(await getChunksForSource(storage, "page://ghost")).toEqual([]);
  });

  it("rejects an empty source_path", async () => {
    await expect(getChunksForSource(storage, "")).rejects.toThrow(/sourcePath/);
  });
});
