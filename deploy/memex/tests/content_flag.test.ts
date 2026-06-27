/**
 * content_flag WARN channel — the normalizer and the post-fusion stamp.
 * A flagged document surfaces `SearchHit.content_flag`; a clean one does not.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { writeDocumentTransaction } from "../src/core/indexer-tx.ts";
import { stampContentFlags } from "../src/core/search/content-flag.ts";
import type { SearchHit } from "../src/core/search/hybrid.ts";

describe("stampContentFlags", () => {
  let tmp: string;
  let storage: Storage;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "memex-content-flag-"));
    storage = new Storage({ dbPath: join(tmp, "db") });
    await storage.init();
    await writeDocumentTransaction(
      storage,
      { documentId: "doc_flagged", sourcePath: "/notes/f.md", title: "f", frontmatter: { content_flag: { reason: "oversized", detail: "big" } }, embeddingModel: "det" },
      [{ text: "flagged body", entities: [] }],
    );
    await writeDocumentTransaction(
      storage,
      { documentId: "doc_clean", sourcePath: "/notes/c.md", title: "c", frontmatter: {}, embeddingModel: "det" },
      [{ text: "clean body", entities: [] }],
    );
  });
  afterEach(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  function hit(documentId: string): SearchHit {
    return { chunkId: `${documentId}_c0`, documentId, sourcePath: "", title: null, content: "", score: 1, intent: "topic" };
  }

  it("stamps only the flagged document's hit", async () => {
    const hits = [hit("doc_flagged"), hit("doc_clean")];
    await stampContentFlags(storage.engine(), hits);
    expect(hits[0]?.content_flag).toEqual({ reason: "oversized", detail: "big" });
    expect(hits[1]?.content_flag).toBeUndefined();
  });

  it("is a no-op on an empty set and never throws", async () => {
    await expect(stampContentFlags(storage.engine(), [])).resolves.toBeUndefined();
  });
});
