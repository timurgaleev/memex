/**
 * Hermetic retrieval-quality gate over the FULL HYBRID path (vector + keyword
 * + RRF fusion) — the follow-up the keyword-only gate (retrieval_quality.test)
 * flagged as needing a deterministic query-embedder.
 *
 * Both arms run with NO Bedrock: chunk embeddings are seeded with the
 * deterministic basis-vector embedder (det-embed.ts), and the same embedder is
 * injected into hybridSearch via the `embedQuery` seam. Intent is overridden
 * and expansion + cache disabled, so the entire pipeline — vectorSearch (cosine
 * over seeded vectors) + keywordSearch (FTS) + reciprocal-rank fusion — is
 * exercised deterministically. A change that regresses HYBRID ranking below the
 * floors turns the suite red in CI.
 *
 * Floors are conservative; raise as ranking matures. Floors are env-overridable
 * so a maintainer can ratchet them without editing the test.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { writeDocumentTransaction } from "../src/core/indexer-tx.ts";
import { hybridSearch } from "../src/core/search/index.ts";
import { keywordSearch } from "../src/core/search/keyword.ts";
import {
  recallAtK,
  reciprocalRank,
  ndcgAtK,
  binaryGrades,
} from "../src/core/search/metrics.ts";
import { deterministicEmbed, deterministicEmbedQuery } from "./det-embed.ts";

const K = 5;

// Distinct-vocabulary corpus so each arm has an unambiguous target per query.
const CORPUS: { id: string; content: string }[] = [
  { id: "doc_zigbee", content: "home assistant zigbee pairing setup guide" },
  { id: "doc_models", content: "bedrock nova model selection titan embeddings" },
  { id: "doc_recency", content: "recency decay ranking half life retrieval signal" },
  { id: "doc_graph", content: "graph neighbors relationship edges provenance redaction" },
  { id: "doc_cache", content: "query cache generation clock invalidation lookup" },
  // Vector-arm probe: its terms (car/maintenance) are reachable from a query's
  // synonyms (automobile/servicing) ONLY through the embedder, never via FTS.
  { id: "doc_vehicle", content: "car maintenance schedule oil change log" },
  // Near-dup pair (a note and its `.bak`): nearly identical text in two
  // DIFFERENT docs (>= the 12-token near-dup floor) → the Jaccard near-dup
  // stage must keep only one.
  {
    id: "doc_widget",
    content: "widget calibration procedure alpha bravo charlie delta echo foxtrot golf hotel india juliet",
  },
  {
    id: "doc_widget_bak",
    content: "widget calibration procedure alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo",
  },
  { id: "doc_noise", content: "unrelated lorem ipsum filler placeholder prose" },
];

const QRELS: { id: string; query: string; relevant: string[] }[] = [
  { id: "zigbee", query: "zigbee pairing setup", relevant: ["doc_zigbee"] },
  { id: "models", query: "bedrock nova model selection", relevant: ["doc_models"] },
  { id: "recency", query: "recency decay ranking", relevant: ["doc_recency"] },
  { id: "graph", query: "graph relationship edges", relevant: ["doc_graph"] },
  { id: "cache", query: "query cache invalidation", relevant: ["doc_cache"] },
  // Found ONLY via the vector arm (synonym bridge) — keyword FTS misses it,
  // so a broken vector arm would drop this query's hit rate and fail the gate.
  { id: "vehicle_synonym", query: "automobile servicing", relevant: ["doc_vehicle"] },
];

// Env-overridable floors — the gate. Conservative defaults.
const num = (name: string, dflt: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return dflt;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : dflt;
};
const FLOOR_HIT_RATE = num("MEMEX_GATE_HYBRID_HIT", 1.0);
const FLOOR_MEAN_RR = num("MEMEX_GATE_HYBRID_MRR", 0.8);
const FLOOR_MEAN_NDCG = num("MEMEX_GATE_HYBRID_NDCG", 0.8);

const toDocId = (chunkId: string): string => chunkId.replace(/_c\d+$/, "");

let tmp: string;
let storage: Storage;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-retr-hybrid-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  for (const d of CORPUS) {
    await writeDocumentTransaction(
      storage,
      {
        documentId: d.id,
        sourcePath: `/${d.id}.md`,
        title: d.id,
        frontmatter: {},
        embeddingModel: "deterministic-test",
      },
      // Seed the deterministic vector alongside the text so the vector arm has
      // something real to rank (writeDocumentTransaction writes the embedding
      // the caller supplies; it does not call Bedrock).
      [{ text: d.content, entities: [], embedding: deterministicEmbed(d.content) }],
    );
  }
});

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("retrieval-quality gate (full hybrid, hermetic)", () => {
  it("meets the floor thresholds across the query families", async () => {
    let rrSum = 0;
    let ndcgSum = 0;
    let hits = 0;
    const perQuery: Record<string, { recall: number; rr: number; ndcg: number }> = {};

    for (const q of QRELS) {
      const result = await hybridSearch(storage, q.query, {
        k: K,
        intent: "topic", // skip Nova intent classification
        noExpansion: true, // skip Nova query expansion
        noCache: true, // exercise the live path every call
        embedQuery: deterministicEmbedQuery, // skip Titan embedding
      });
      // Dedup to doc ids in rank order (first occurrence wins).
      const seen = new Set<string>();
      const docs: string[] = [];
      for (const h of result) {
        const d = toDocId(h.chunkId);
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

    const hitRate = hits / QRELS.length;
    const meanRR = rrSum / QRELS.length;
    const meanNdcg = ndcgSum / QRELS.length;

    // perQuery is in scope for debugging a regression.
    expect(hitRate).toBeGreaterThanOrEqual(FLOOR_HIT_RATE);
    expect(meanRR).toBeGreaterThanOrEqual(FLOOR_MEAN_RR);
    expect(meanNdcg).toBeGreaterThanOrEqual(FLOOR_MEAN_NDCG);
  });

  it("the vector arm carries a query the keyword arm cannot match", async () => {
    // "automobile servicing" shares NO literal token with any doc, so the
    // keyword/FTS arm finds nothing — proving the next assertion is a pure
    // vector-arm signal (the embedder bridges automobile→car, servicing→
    // maintenance to doc_vehicle's terms).
    const kw = await keywordSearch(storage.engine(), "automobile servicing", K);
    expect(kw.map(toDocId)).not.toContain("doc_vehicle");

    // Through the full hybrid path, the vector arm surfaces doc_vehicle at #1.
    const result = await hybridSearch(storage, "automobile servicing", {
      k: K,
      intent: "topic",
      noExpansion: true,
      noCache: true,
      embedQuery: deterministicEmbedQuery,
    });
    expect(result.length).toBeGreaterThan(0);
    expect(toDocId(result[0]!.chunkId)).toBe("doc_vehicle");
  });

  it("near-dup stage collapses two near-identical documents to one", async () => {
    const result = await hybridSearch(storage, "widget calibration procedure", {
      k: K,
      intent: "topic",
      noExpansion: true,
      noCache: true,
      embedQuery: deterministicEmbedQuery,
    });
    const widgets = result.map((h) => toDocId(h.chunkId)).filter((d) => d.startsWith("doc_widget"));
    // Both doc_widget and doc_widget_bak match strongly, but the Jaccard
    // near-dup stage keeps only the higher-ranked twin.
    expect(widgets.length).toBe(1);
  });

  it("exact intent keeps BOTH near-dup twins (no dedup at all)", async () => {
    const result = await hybridSearch(storage, "widget calibration procedure", {
      k: K,
      intent: "exact", // exact intent skips per-doc AND near-dup dedup
      noExpansion: true,
      noCache: true,
      embedQuery: deterministicEmbedQuery,
    });
    const widgets = result.map((h) => toDocId(h.chunkId)).filter((d) => d.startsWith("doc_widget"));
    expect(widgets.length).toBe(2);
  });
});
