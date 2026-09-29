/**
 * Recency decays on documents.effective_date (content date), not updated_at.
 * Two docs with IDENTICAL updated_at but different effective_date: the one whose
 * CONTENT is older must rank below the fresher one. Under the old wiring (decay
 * on updated_at) both looked equally fresh, so this is the regression guard for
 * the effective_date fix in hybrid.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { writeDocumentTransaction } from "../src/core/indexer-tx.ts";
import { hybridSearch } from "../src/core/search/index.ts";
import { deterministicEmbed, deterministicEmbedQuery } from "./det-embed.ts";

let tmp: string;
let storage: Storage;

// Same content → identical keyword + vector scores pre-recency, so recency is
// the ONLY differentiator. Under a daily/ prefix decay is aggressive.
const BODY = "quarterly revenue report growth margin forecast";

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-recency-eff-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  for (const id of ["daily/old-content", "daily/new-content"]) {
    await writeDocumentTransaction(
      storage,
      {
        documentId: id,
        sourcePath: `/${id}.md`,
        title: id,
        frontmatter: {},
        embeddingModel: "deterministic-test",
      },
      [{ text: BODY, entities: [], embedding: deterministicEmbed(BODY) }],
    );
  }
  const engine = storage.engine();
  // Both rows: updated_at = now (as if just re-ingested). effective_date
  // diverges: old-content is a year stale, new-content is today.
  await engine.query(
    `UPDATE documents SET updated_at = NOW(),
       effective_date = (NOW() - interval '400 days')::date
     WHERE id = 'daily/old-content'`,
  );
  await engine.query(
    `UPDATE documents SET updated_at = NOW(),
       effective_date = NOW()::date
     WHERE id = 'daily/new-content'`,
  );
});

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("recency decays on effective_date", () => {
  it("ranks the fresher-by-content-date doc above the stale one despite equal updated_at", async () => {
    const result = await hybridSearch(storage, "quarterly revenue growth", {
      k: 5,
      intent: "topic",
      noExpansion: true,
      noCache: true,
      embedQuery: deterministicEmbedQuery,
    });
    const toDocId = (chunkId: string): string => chunkId.replace(/_c\d+$/, "");
    const scoreOf = (docId: string): number | undefined => {
      for (const h of result) if (toDocId(h.chunkId) === docId) return h.score;
      return undefined;
    };
    const sNew = scoreOf("daily/new-content");
    const sOld = scoreOf("daily/old-content");
    expect(sNew).toBeDefined();
    expect(sOld).toBeDefined();
    // Fresh content date must score STRICTLY higher. Old wiring decayed on the
    // (identical) updated_at → equal scores → this strict inequality would fail.
    expect(sNew!).toBeGreaterThan(sOld!);
  });
});
