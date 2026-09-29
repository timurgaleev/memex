/**
 * Hermetic retrieval-quality gate over the keyword (FTS) path.
 *
 * Seeds a tiny deterministic corpus, runs `keywordSearch` for a set of
 * query families, scores each with the pure IR metrics, and asserts floor
 * thresholds. Fully deterministic — Postgres/PGLite FTS only, no Bedrock,
 * no embeddings — so it runs in CI as a correctness gate: if a change
 * regresses keyword ranking below the floors, the suite goes red.
 *
 * Scope note: this gates the KEYWORD arm. A full hybrid gate needs a
 * deterministic query-embedder injection point in hybridSearch (today the
 * vector arm embeds via Bedrock) — tracked as a follow-up. Floors are
 * intentionally conservative; tighten as the corpus/ranking matures.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { writeDocumentTransaction } from "../src/core/indexer-tx.ts";
import { keywordSearch } from "../src/core/search/keyword.ts";
import {
  recallAtK,
  reciprocalRank,
  ndcgAtK,
  binaryGrades,
} from "../src/core/search/metrics.ts";

const K = 5;

// Deterministic corpus: one chunk per doc, content carries the searchable
// terms. Distinct vocabularies so FTS has an unambiguous target per query.
const CORPUS: { id: string; content: string }[] = [
  { id: "doc_zigbee", content: "home assistant zigbee pairing setup guide" },
  { id: "doc_models", content: "bedrock nova model selection titan embeddings" },
  { id: "doc_recency", content: "recency decay ranking half life retrieval signal" },
  { id: "doc_graph", content: "graph neighbors relationship edges provenance redaction" },
  { id: "doc_cache", content: "query cache generation clock invalidation lookup" },
  { id: "doc_noise", content: "unrelated lorem ipsum filler placeholder prose" },
];

// qrels: query → relevant doc ids. Empty = nothing relevant (absence query).
const QRELS: { id: string; query: string; relevant: string[] }[] = [
  { id: "zigbee", query: "zigbee pairing setup", relevant: ["doc_zigbee"] },
  { id: "models", query: "bedrock nova model selection", relevant: ["doc_models"] },
  { id: "recency", query: "recency decay ranking", relevant: ["doc_recency"] },
  { id: "graph", query: "graph relationship edges", relevant: ["doc_graph"] },
  { id: "cache", query: "query cache invalidation", relevant: ["doc_cache"] },
  { id: "absent", query: "nonexistent topic xyzzy", relevant: [] },
];

// Floors — the gate. Conservative; raise as ranking improves.
const FLOOR_HIT_RATE = 1.0; // every present-target query finds its doc in top-K
const FLOOR_MEAN_RR = 0.8; // and usually at rank 1
const FLOOR_MEAN_NDCG = 0.8;

/** chunk id `doc_x_c0` → doc id `doc_x`. */
const toDocId = (chunkId: string): string => chunkId.replace(/_c\d+$/, "");

let tmp: string;
let storage: Storage;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-retr-quality-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  for (const d of CORPUS) {
    await writeDocumentTransaction(
      storage,
      { documentId: d.id, sourcePath: `/${d.id}.md`, title: d.id, frontmatter: {} },
      [{ text: d.content, entities: [] }],
    );
  }
});

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("retrieval-quality gate (keyword/FTS, hermetic)", () => {
  it("meets the floor thresholds across the query families", async () => {
    const engine = storage.engine();
    const present = QRELS.filter((q) => q.relevant.length > 0);

    let rrSum = 0;
    let ndcgSum = 0;
    let hits = 0;
    const perQuery: Record<string, { recall: number; rr: number; ndcg: number }> = {};

    for (const q of present) {
      const chunkIds = await keywordSearch(engine, q.query, K);
      // Dedup to doc ids in rank order (first occurrence wins).
      const seen = new Set<string>();
      const docs: string[] = [];
      for (const c of chunkIds) {
        const d = toDocId(c);
        if (!seen.has(d)) {
          seen.add(d);
          docs.push(d);
        }
      }
      const rel = new Set(q.relevant);
      const recall = recallAtK(docs, rel, K);
      const rr = reciprocalRank(docs, rel);
      const ndcg = ndcgAtK(docs, binaryGrades(q.relevant), K);
      perQuery[q.id] = { recall, rr, ndcg };
      if (recall > 0) hits++;
      rrSum += rr;
      ndcgSum += ndcg;
    }

    const hitRate = hits / present.length;
    const meanRR = rrSum / present.length;
    const meanNdcg = ndcgSum / present.length;

    // The gate. (perQuery is in scope for a failure message if needed.)
    expect(hitRate).toBeGreaterThanOrEqual(FLOOR_HIT_RATE);
    expect(meanRR).toBeGreaterThanOrEqual(FLOOR_MEAN_RR);
    expect(meanNdcg).toBeGreaterThanOrEqual(FLOOR_MEAN_NDCG);
  });

  it("returns nothing relevant for an absence query", async () => {
    const chunkIds = await keywordSearch(storage.engine(), "nonexistent topic xyzzy", K);
    const docs = chunkIds.map(toDocId);
    // None of the corpus docs should match an out-of-vocabulary query.
    expect(docs.length).toBe(0);
  });
});
