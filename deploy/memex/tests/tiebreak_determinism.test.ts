/**
 * Deterministic tie-break in the KEYWORD retrieval arm.
 *
 * `keywordSearch` (ts_rank_cd) orders by score with a `, id COLLATE "C" ASC`
 * secondary key, so equal-rank ties — common when several chunks share the
 * query terms — resolve in a stable BYTE order. `COLLATE "C"` is what makes it
 * truly platform-independent: a bare `id ASC` would inherit the database's
 * default collation (PGLite/C locally vs en_US/ICU on live RDS), which can
 * diverge — the exact green-local / red-Linux flakiness this guards against in
 * the hermetic retrieval-quality gates.
 *
 * The VECTOR arm is intentionally NOT given a secondary key: a tiebreak column
 * on a pgvector `<=>` ORDER BY can defeat the HNSW index (forcing a full exact
 * scan), and exact cosine ties on real vectors are vanishingly rare. The HNSW
 * traversal is already deterministic for a given index, so the vector arm is
 * asserted only for REPEATABILITY here, not a specific tie order.
 *
 * Seeds several chunks with IDENTICAL content (→ identical ts_rank) and the
 * IDENTICAL embedding vector (→ cosine distance 0 for all), so every result is
 * a perfect tie.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { writeDocumentTransaction } from "../src/core/indexer-tx.ts";
import { keywordSearch } from "../src/core/search/keyword.ts";
import { vectorSearch } from "../src/core/search/vector.ts";
import { deterministicEmbed } from "./det-embed.ts";

// Identical content + vector across docs → every hit is a perfect tie.
const CONTENT = "identical tied content for the tiebreak probe";
const VEC = deterministicEmbed(CONTENT);
// Insert in deliberately NON-sorted id order to prove ORDER BY (not insertion
// order) drives the result.
const DOC_IDS = ["doc_m", "doc_a", "doc_z", "doc_c", "doc_b"];
const EXPECTED = [...DOC_IDS].map((d) => `${d}_c0`).sort(); // id-ascending

let tmp: string;
let storage: Storage;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-tiebreak-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  for (const id of DOC_IDS) {
    await writeDocumentTransaction(
      storage,
      { documentId: id, sourcePath: `/${id}.md`, title: id, frontmatter: {}, embeddingModel: "det" },
      [{ text: CONTENT, entities: [], embedding: VEC }],
    );
  }
});

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("retrieval tie-break determinism", () => {
  it("keywordSearch resolves ties in id-ascending order, repeatably", async () => {
    const a = await keywordSearch(storage.engine(), "identical tied content", 10);
    const b = await keywordSearch(storage.engine(), "identical tied content", 10);
    expect(a).toEqual(EXPECTED);
    expect(b).toEqual(a); // stable across calls
  });

  it("vectorSearch returns all tied chunks in a repeatable order", async () => {
    const a = await vectorSearch(storage.engine(), VEC, 10);
    const b = await vectorSearch(storage.engine(), VEC, 10);
    // No id tie-break on the vector arm (would risk the HNSW index), but the
    // result set is complete and the order is stable across calls.
    expect([...a].sort()).toEqual(EXPECTED);
    expect(b).toEqual(a);
  });
});
