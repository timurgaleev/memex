/**
 * An unscoped writer (the operator, the local CLI) may write into a page owned
 * by another source. Everything derived from that write — link edges, the
 * delete/restore version markers, tags — belongs to the PAGE's source, so the
 * owning tenant keeps seeing it through its own scoped reads.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";
import { putPage } from "../src/core/pages.ts";
import { registerSource } from "../src/core/sources.ts";
import { getTags } from "../src/core/tags.ts";

setDefaultTimeout(30000);

const OWNER = "tenant-a";
const PAGE = "notes/owned-by-a";
const TARGET = "notes/link-target-a";

let tmp: string;
let storage: Storage;

async function operator(name: string, args: Record<string, unknown>) {
  const res = await dispatchTool(storage, { name, arguments: args });
  expect(res.isError ?? false).toBe(false);
  return JSON.parse(res.content[0]!.text);
}

async function linkSources(slug: string): Promise<string[]> {
  const r = await storage.engine().query<{ source_id: string }>(
    `SELECT DISTINCT source_id FROM links WHERE source_slug = $1 ORDER BY source_id`,
    [slug],
  );
  return r.rows.map((row) => row.source_id);
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-derived-owner-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  await registerSource(storage.engine(), { id: OWNER, kind: "vault", pathPrefix: "/tenant-a" });
  await putPage(storage, { slug: TARGET, type: "note", title: "Target", markdown_body: "target", source_id: OWNER });
  await putPage(storage, { slug: PAGE, type: "note", title: "Owned", markdown_body: "first version", source_id: OWNER });
});

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("unscoped writes into a tenant page", () => {
  it("page_append derives its link edges under the page's source", async () => {
    await operator("page_append", { slug: PAGE, content: `See [[${TARGET}]].` });
    expect(await linkSources(PAGE)).toEqual([OWNER]);
  });

  it("page_revert re-derives link edges under the page's source", async () => {
    await operator("page_put", { slug: PAGE, markdown_body: `Now links [[${TARGET}]] again.`, title: "Owned" });
    await operator("page_revert", { slug: PAGE, version: 1 });
    await operator("page_revert", { slug: PAGE, version: 2 });
    expect(await linkSources(PAGE)).toEqual([OWNER]);
  });

  it("delete and restore markers carry the page's source", async () => {
    await operator("page_delete", { slug: PAGE });
    await operator("page_restore", { slug: PAGE });
    const r = await storage.engine().query<{ source_id: string }>(
      `SELECT source_id FROM page_versions
        WHERE slug = $1 AND body_snapshot = ''
          AND (compiled_truth_snapshot ? 'deleted_at' OR compiled_truth_snapshot ? 'restored_at')`,
      [PAGE],
    );
    expect(r.rows.length).toBe(2);
    expect(r.rows.map((row) => row.source_id)).toEqual([OWNER, OWNER]);
  });

  it("add_tag stamps the page's source, so the owner sees the tag", async () => {
    await operator("add_tag", { slug: PAGE, tag: "operator-label" });
    expect(await getTags(storage, PAGE, [OWNER])).toContain("operator-label");
    const r = await storage.engine().query<{ source_id: string }>(
      `SELECT source_id FROM tags WHERE slug = $1 AND tag = 'operator-label'`,
      [PAGE],
    );
    expect(r.rows.map((row) => row.source_id)).toEqual([OWNER]);
  });
});
