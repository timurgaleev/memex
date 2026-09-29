/**
 * Live-model generation clock (documents) — migration 025.
 *
 * Fresh PGLite Storage per test. Verifies the singleton starts at 0, the
 * raw bump advances it, and a real document write through
 * writeDocumentTransaction bumps it exactly once.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import {
  bumpDocumentClock,
  currentDocumentClock,
} from "../src/core/generation.ts";
import { writeDocumentTransaction } from "../src/core/indexer-tx.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-docclock-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("document generation clock", () => {
  it("starts at 0 with a singleton row", async () => {
    expect(await currentDocumentClock(storage.engine())).toBe(0);
  });

  it("advances on a raw bump inside a transaction", async () => {
    await storage.engine().transaction(async (tx) => {
      await bumpDocumentClock(tx);
      await bumpDocumentClock(tx);
    });
    expect(await currentDocumentClock(storage.engine())).toBe(2);
  });

  it("bumps once per document write through the indexer", async () => {
    await writeDocumentTransaction(
      storage,
      {
        documentId: "doc_a",
        sourcePath: "/notes/a.md",
        title: "A",
        frontmatter: {},
      },
      [{ text: "hello world", entities: [] }],
    );
    expect(await currentDocumentClock(storage.engine())).toBe(1);

    // Re-indexing the same document (content change) bumps again.
    await writeDocumentTransaction(
      storage,
      {
        documentId: "doc_a",
        sourcePath: "/notes/a.md",
        title: "A",
        frontmatter: {},
      },
      [{ text: "hello world v2", entities: [] }],
    );
    expect(await currentDocumentClock(storage.engine())).toBe(2);
  });
});
