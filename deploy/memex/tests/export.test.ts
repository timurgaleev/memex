/**
 * `memex export` — dumps live pages to a markdown tree, scoped by --source.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { putPage } from "../src/core/pages.ts";
import { runExport } from "../src/commands/export.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-export-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});
afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("runExport", () => {
  it("writes one markdown file per page, mirroring slug dirs", async () => {
    await putPage(storage, {
      slug: "people/alice",
      type: "person",
      title: "Alice",
      markdown_body: "# Alice\n\nWorks on the platform.",
    });
    const out = join(tmp, "dump");
    await runExport({ dir: out, storage });
    const fp = join(out, "people/alice.md");
    expect(existsSync(fp)).toBe(true);
    const md = readFileSync(fp, "utf-8");
    expect(md).toContain("---\ntitle: Alice\ntype: person\n---");
    expect(md).toContain("Works on the platform.");
  });

  it("--source scopes the dump to one tenant", async () => {
    for (const id of ["src-a", "src-b"]) {
      await storage.engine().query(
        "INSERT INTO sources (id, kind, path_prefix) VALUES ($1, 'other', $2) ON CONFLICT (id) DO NOTHING",
        [id, `/${id}`],
      );
    }
    await putPage(storage, { slug: "notes/a", type: "note", markdown_body: "tenant A", source_id: "src-a" });
    await putPage(storage, { slug: "notes/b", type: "note", markdown_body: "tenant B", source_id: "src-b" });
    const out = join(tmp, "dump");
    await runExport({ dir: out, sourceIds: ["src-a"], storage });
    expect(existsSync(join(out, "notes/a.md"))).toBe(true);
    expect(existsSync(join(out, "notes/b.md"))).toBe(false);
  });
});
