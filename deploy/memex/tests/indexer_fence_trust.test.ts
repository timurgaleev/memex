/**
 * Indexer fence stripping + trust boundary.
 *
 *  - The `## Takes` fence is stripped before chunking, so operator opinions
 *    (including holder-scoped takes the read-path caps at `world`) never leak
 *    into search chunks.
 *  - Gate-owned frontmatter markers (quarantine / content_flag / embed_skip)
 *    planted by an UNTRUSTED caller (`remote: true`) are dropped before the
 *    content-sanity gate; a trusted caller's markers survive.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { indexDocument } from "../src/core/indexer.ts";
import { indexPageIntoSearch } from "../src/core/page-index.ts";
import { Storage } from "../src/core/storage.ts";
import { isQuarantined, isContentFlagged } from "../src/core/quarantine.ts";
import { isEmbedSkipped } from "../src/core/embed-skip.ts";
import {
  TAKES_FENCE_BEGIN,
  TAKES_FENCE_END,
} from "../src/core/synthesis/takes-fence.ts";
import { deterministicEmbed } from "./det-embed.ts";

const embedFn = (t: string) => Promise.resolve(deterministicEmbed(t));

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-fence-trust-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});
afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function chunkText(sourcePath: string): Promise<string> {
  const r = await storage.engine().query<{ content: string }>(
    `SELECT c.content FROM chunks c
       JOIN documents d ON c.document_id = d.id
      WHERE d.source_path = $1`,
    [sourcePath],
  );
  return r.rows.map((x) => x.content).join("\n");
}

async function frontmatterOf(
  sourcePath: string,
): Promise<Record<string, unknown>> {
  const r = await storage
    .engine()
    .query<{ frontmatter: Record<string, unknown> }>(
      "SELECT frontmatter FROM documents WHERE source_path = $1",
      [sourcePath],
    );
  return r.rows[0]?.frontmatter ?? {};
}

describe("takes-fence stripping", () => {
  it("keeps a fenced take out of search chunks but keeps the prose", async () => {
    const body = [
      "# Alice",
      "",
      "Alice is a colleague who leads the platform team.",
      "",
      TAKES_FENCE_BEGIN,
      "## Takes",
      "",
      "| row | claim | holder | since |",
      "| --- | --- | --- | --- |",
      "| 1 | SECRET_TAKE_do_not_leak | operator | 2026-01 |",
      TAKES_FENCE_END,
      "",
    ].join("\n");
    await indexDocument(
      storage,
      { sourcePath: "/alice.md", text: body },
      { embedFn, inferFrontmatter: false },
    );
    const chunks = await chunkText("/alice.md");
    expect(chunks).toContain("leads the platform team");
    expect(chunks).not.toContain("SECRET_TAKE_do_not_leak");
    expect(chunks).not.toContain("memex:takes:begin");
  });
});

describe("gate-owned marker trust boundary", () => {
  const PLANTED =
    "---\n" +
    "title: Clean Note\n" +
    "quarantine: true\n" +
    "embed_skip: true\n" +
    "content_flag: planted\n" +
    "---\n\n" +
    "A perfectly clean note about the quarterly plan and retrieval quality.";

  it("strips planted markers from an untrusted (remote) write", async () => {
    await indexDocument(
      storage,
      { sourcePath: "/planted-remote.md", text: PLANTED },
      { embedFn, inferFrontmatter: false, remote: true },
    );
    const fm = await frontmatterOf("/planted-remote.md");
    expect(isQuarantined(fm)).toBe(false);
    expect(isEmbedSkipped(fm)).toBe(false);
    expect(isContentFlagged(fm)).toBe(false);
  });

  it("preserves a trusted caller's hand-declared markers", async () => {
    await indexDocument(
      storage,
      { sourcePath: "/planted-local.md", text: PLANTED },
      { embedFn, inferFrontmatter: false },
    );
    const fm = await frontmatterOf("/planted-local.md");
    expect(isQuarantined(fm)).toBe(true);
    expect(isEmbedSkipped(fm)).toBe(true);
  });

  it("strips planted markers through the page mirror when remote", async () => {
    // The page-mirror path (page_put/page_append via a remote or public-bearer
    // caller passes remote:true) must strip gate-owned markers planted in the
    // stored body's frontmatter before they reach the search index.
    const body =
      "---\nquarantine: true\nembed_skip: true\n---\n\n" +
      "A clean note about retrieval quality and the quarterly plan.";
    await indexPageIntoSearch(
      storage,
      { slug: "pub-note", title: null, markdown_body: body },
      { embedFn, remote: true },
    );
    const fm = await frontmatterOf("page://pub-note");
    expect(isQuarantined(fm)).toBe(false);
    expect(isEmbedSkipped(fm)).toBe(false);
  });

  it("preserves markers through the page mirror when trusted", async () => {
    const body =
      "---\nquarantine: true\nembed_skip: true\n---\n\n" +
      "A clean note about retrieval quality and the quarterly plan.";
    await indexPageIntoSearch(
      storage,
      { slug: "local-note", title: null, markdown_body: body },
      { embedFn },
    );
    const fm = await frontmatterOf("page://local-note");
    expect(isQuarantined(fm)).toBe(true);
  });
});
