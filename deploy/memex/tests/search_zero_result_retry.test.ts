/**
 * Zero-result broadened retry: an exact-intent pass that finds nothing re-runs
 * once as `topic`, re-enabling the synonym expansion pass. Hermetic — the vector
 * arm is forced null (embedQuery throws) so the miss is real, and expansion is
 * injected deterministically (no Bedrock).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { writeDocumentTransaction } from "../src/core/indexer-tx.ts";
import { hybridSearch } from "../src/core/search/index.ts";
import { deterministicEmbed } from "./det-embed.ts";

let tmp: string;
let storage: Storage;

const nullVec = async (): Promise<number[]> => {
  throw new Error("no vector arm in this test");
};
// The only synonym that bridges "car" → the seeded doc's vocabulary.
const fakeExpander = async (): Promise<string[]> => ["automobile servicing"];

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-zero-retry-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  const body = "automobile servicing schedule and maintenance log";
  await writeDocumentTransaction(
    storage,
    {
      documentId: "doc_auto",
      sourcePath: "/doc_auto.md",
      title: "auto",
      frontmatter: {},
      embeddingModel: "deterministic-test",
    },
    [{ text: body, entities: [], embedding: deterministicEmbed(body) }],
  );
});

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("zero-result broadened retry", () => {
  it("an empty exact-intent pass retries as topic and surfaces the synonym hit", async () => {
    const hits = await hybridSearch(storage, "car", {
      k: 5,
      intent: "exact", // exact skips expansion → first pass finds nothing
      embedQuery: nullVec, // force keyword-only; keyword "car" misses
      expandQueryFn: fakeExpander,
      noCache: true,
    });
    expect(hits.map((h) => h.documentId)).toContain("doc_auto");
  });

  it("does NOT retry when the caller opted out of expansion", async () => {
    const hits = await hybridSearch(storage, "car", {
      k: 5,
      intent: "exact",
      noExpansion: true, // LLM-free caller — honor it, no broaden
      embedQuery: nullVec,
      expandQueryFn: fakeExpander,
      noCache: true,
    });
    expect(hits).toHaveLength(0);
  });

  it("does NOT retry a filtered empty result (empty filter set is correct)", async () => {
    const hits = await hybridSearch(storage, "car", {
      k: 5,
      intent: "exact",
      since: "2099-01-01", // filter guarantees empty; retry must not fire
      embedQuery: nullVec,
      expandQueryFn: fakeExpander,
      noCache: true,
    });
    expect(hits).toHaveLength(0);
  });
});
