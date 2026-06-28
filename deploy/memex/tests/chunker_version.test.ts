/**
 * Per-document chunker version (migration 052) — the index stamp +
 * countStaleChunkerDocs. A document is stale when its stamp is below the current
 * chunker version for its kind (markdown vs code, independent namespaces).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { writeDocumentTransaction } from "../src/core/indexer-tx.ts";
import { countStaleChunkerDocs } from "../src/core/chunker-version.ts";
import { MARKDOWN_CHUNKER_VERSION } from "../src/core/chunkers/recursive.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-chunkerv-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});
afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function versionOf(id: string): Promise<number> {
  const r = await storage.engine().query<{ v: number }>(
    "SELECT chunker_version AS v FROM documents WHERE id = $1",
    [id],
  );
  return Number(r.rows[0]?.v);
}

describe("chunker_version stamp", () => {
  it("stamps the passed version on index; defaults to 1 when omitted", async () => {
    await writeDocumentTransaction(
      storage,
      { documentId: "d_md", sourcePath: "/a.md", title: "a", frontmatter: {}, embeddingModel: "det", chunkerVersion: MARKDOWN_CHUNKER_VERSION },
      [{ text: "body", entities: [] }],
    );
    expect(await versionOf("d_md")).toBe(MARKDOWN_CHUNKER_VERSION);

    // Omitted → the column DEFAULT 1 (grandfather) applies.
    await writeDocumentTransaction(
      storage,
      { documentId: "d_legacy", sourcePath: "/b.md", title: "b", frontmatter: {}, embeddingModel: "det" },
      [{ text: "body", entities: [] }],
    );
    expect(await versionOf("d_legacy")).toBe(1);
  });
});

describe("countStaleChunkerDocs", () => {
  it("is zero when every document is at the current version", async () => {
    await writeDocumentTransaction(
      storage,
      { documentId: "d1", sourcePath: "/a.md", title: "a", frontmatter: {}, embeddingModel: "det", chunkerVersion: MARKDOWN_CHUNKER_VERSION },
      [{ text: "body", entities: [] }],
    );
    expect(await countStaleChunkerDocs(storage.engine())).toBe(0);
  });

  it("counts a markdown doc stamped below the current markdown version", async () => {
    const e = storage.engine();
    await writeDocumentTransaction(
      storage,
      { documentId: "d_old", sourcePath: "/a.md", title: "a", frontmatter: {}, embeddingModel: "det", chunkerVersion: MARKDOWN_CHUNKER_VERSION },
      [{ text: "body", entities: [] }],
    );
    // Simulate a chunker-version bump: force the stored stamp below current.
    await e.query("UPDATE documents SET chunker_version = chunker_version - 1 WHERE id = $1", ["d_old"]);
    expect(await countStaleChunkerDocs(e)).toBe(1);
  });

  it("branches on kind — a code doc is judged against the code namespace, not markdown", async () => {
    const e = storage.engine();
    // A code doc at version 1 with the code current = 1 → not stale even though
    // we lower it below the markdown current would be (same number, different axis).
    await writeDocumentTransaction(
      storage,
      { documentId: "d_code", sourcePath: "/x.ts", title: "x.ts", frontmatter: { kind: "code" }, embeddingModel: null, chunkerVersion: 1 },
      [{ text: "fn()", entities: [], symbolName: "fn" }],
    );
    expect(await countStaleChunkerDocs(e)).toBe(0);
  });
});
