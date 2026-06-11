/**
 * Weighted chunk FTS (migration 030).
 *
 * The keyword arm now ranks against `search_vector`, which puts a code
 * chunk's symbol identity (symbol_name + parent_symbol_path) at weight 'A'
 * and the body text at weight 'B'. A query that names a symbol must rank the
 * chunk carrying that symbol ABOVE a markdown chunk that only mentions the
 * term in prose — even when the body text is otherwise identical.
 *
 * Also guards the no-regression contract: a markdown chunk with no symbol
 * columns still matches the same queries it matched under the old un-weighted
 * `ts` (config is unchanged 'simple', so the matched SET is identical; only
 * the rank weighting differs).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { writeDocumentTransaction } from "../src/core/indexer-tx.ts";
import { keywordSearch } from "../src/core/search/keyword.ts";

// Identical body in both chunks; only the CODE chunk also carries the term as
// its symbol_name → it gains a weight-'A' hit on top of the shared weight-'B'
// body hit, so ts_rank_cd ranks it first.
const TERM = "paymentprocessor";
const BODY = `the ${TERM} appears once here in otherwise ordinary prose`;

let tmp: string;
let storage: Storage;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-weighted-fts-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();

  // Markdown chunk: term in body only (weight B).
  await writeDocumentTransaction(
    storage,
    { documentId: "doc_prose", sourcePath: "/prose.md", title: "prose", frontmatter: {}, embeddingModel: "det" },
    [{ text: BODY, entities: [] }],
  );

  // Code chunk: identical body PLUS the term as its symbol name (weight A).
  await writeDocumentTransaction(
    storage,
    { documentId: "doc_code", sourcePath: "/code.ts", title: "code", frontmatter: {}, embeddingModel: "det" },
    [
      {
        text: BODY,
        entities: [],
        symbolName: TERM,
        symbolType: "function",
        parentSymbolPath: ["Billing"],
        language: "typescript",
      },
    ],
  );
});

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("weighted chunk search_vector", () => {
  it("ranks the symbol-bearing code chunk above the prose chunk for a symbol-name query", async () => {
    const ids = await keywordSearch(storage.engine(), TERM, 10);
    expect(ids).toContain("doc_code_c0");
    expect(ids).toContain("doc_prose_c0");
    // Weight-A symbol hit pushes the code chunk to the top.
    expect(ids.indexOf("doc_code_c0")).toBeLessThan(ids.indexOf("doc_prose_c0"));
  });

  it("still matches a markdown chunk on a body-only term (no-regression on the matched set)", async () => {
    const ids = await keywordSearch(storage.engine(), "ordinary prose", 10);
    expect(ids).toContain("doc_prose_c0");
    expect(ids).toContain("doc_code_c0");
  });

  it("boosts a parent-scope query onto the nested code chunk via weight A", async () => {
    // "Billing" is in parent_symbol_path (weight A) but NOT in either body.
    const ids = await keywordSearch(storage.engine(), "Billing", 10);
    expect(ids).toEqual(["doc_code_c0"]);
  });
});
