/**
 * indexFile canonicalizes source_path to an absolute path.
 *
 * `memex index foo.ts` used to persist the caller's relative path verbatim.
 * source_path is the natural key AND the only thing the orphans disk-probe can
 * stat — and that probe checks absolute paths only (virtual `page://` / `gmail:`
 * rows have no file), so a relative-path doc whose file vanished stayed invisible
 * to it forever. Schemes must still pass through untouched.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { indexFile, normalizeSourcePath } from "../src/core/indexer.ts";
import { indexCodeFile } from "../src/core/indexer-code.ts";
import { deterministicEmbed } from "./det-embed.ts";

const detEmbed = (t: string) => Promise.resolve(deterministicEmbed(t));

async function sourcePaths(storage: Storage): Promise<string[]> {
  const r = await storage
    .raw()
    .query<{ source_path: string }>(
      "SELECT source_path FROM documents ORDER BY source_path",
    );
  return r.rows.map((x) => x.source_path);
}

describe("indexFile source_path normalization", () => {
  let tmp: string;
  let storage: Storage;
  let note: string;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "memex-abspath-"));
    storage = new Storage({ dbPath: join(tmp, "db") });
    await storage.init();
    note = join(tmp, "note.md");
    writeFileSync(note, "# Note\n\nbody one\n\nbody two");
  });
  afterEach(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("stores an absolute source_path for a relative-path ingest", async () => {
    const rel = relative(process.cwd(), note);
    expect(isAbsolute(rel)).toBe(false);

    await indexFile(storage, rel, { embedFn: detEmbed });

    expect(await sourcePaths(storage)).toEqual([note]);
  });

  it("re-indexing the same file by relative then absolute path keeps one row", async () => {
    await indexFile(storage, relative(process.cwd(), note), { embedFn: detEmbed });
    await indexFile(storage, note, { embedFn: detEmbed });

    expect(await sourcePaths(storage)).toEqual([note]);
  });

  it("leaves an explicit sourcePath override alone", async () => {
    await indexFile(storage, note, {
      sourcePath: "page://notes/note",
      embedFn: detEmbed,
    });

    expect(await sourcePaths(storage)).toEqual(["page://notes/note"]);
  });

  it("passes virtual schemes through untouched", () => {
    for (const p of [
      "page://notes/foo",
      "page-truth://notes/foo",
      "gmail:18f2c0a",
      "gcal:evt_1",
    ]) {
      expect(normalizeSourcePath(p)).toBe(p);
    }
  });

  it("canonicalizes . and .. inside an otherwise absolute path", () => {
    expect(normalizeSourcePath("/vault/a/../b/./c.md")).toBe("/vault/b/c.md");
  });
});

/**
 * The filed repro is `memex index foo.ts`, and commands/index.ts routes any
 * recognised code extension to indexCodeFile — a different function with its
 * own copy of the same line. Fixing only the markdown path would have left the
 * reported case open while every markdown test went green, which is why this
 * lives here rather than being assumed from the sibling.
 */
describe("indexCodeFile source_path normalization", () => {
  let tmp: string;
  let storage: Storage;
  let src: string;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "memex-abspath-code-"));
    storage = new Storage({ dbPath: join(tmp, "db") });
    await storage.init();
    src = join(tmp, "mod.ts");
    writeFileSync(src, "export function hello(): string {\n  return \"hi\";\n}\n");
  });
  afterEach(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("stores an absolute source_path for `memex index <relative>.ts`", async () => {
    const rel = relative(process.cwd(), src);
    expect(isAbsolute(rel)).toBe(false);

    await indexCodeFile(storage, rel);

    expect(await sourcePaths(storage)).toEqual([src]);
  });

  it("relative then absolute converges on one row", async () => {
    await indexCodeFile(storage, relative(process.cwd(), src));
    await indexCodeFile(storage, src);

    expect(await sourcePaths(storage)).toEqual([src]);
  });
});
