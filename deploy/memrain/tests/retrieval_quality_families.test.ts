/**
 * Query-family retrieval gate — per-family Hit@3 floors over the full hybrid
 * path, hermetic (no Bedrock). Complements the aggregate gate in
 * `retrieval_quality_hybrid.test.ts`: aggregate metrics can stay green while a
 * single retrieval MODE silently regresses. Grouping the qrels into named
 * families and gating each family's Hit@3 independently catches that.
 *
 * Families:
 *   - body_term: the query terms appear verbatim in the target's body (the
 *     baseline keyword + vector path). This family is a CONTROL — it overlaps
 *     the aggregate hybrid gate; the net-new coverage is the two below.
 *   - alias_synonym: the query shares NO literal token with the target — only
 *     the embedder's synonym bridge (automobile→car, servicing→maintenance)
 *     reaches it. A broken vector arm drops this family to zero.
 *   - multi_chunk_dilution: the target is a MULTI-chunk document whose relevant
 *     term lives in exactly one chunk surrounded by unrelated chunks. Exercises
 *     chunk-grain retrieval + per-document dedup surfacing the right doc despite
 *     sibling-chunk noise (no other test seeds a multi-chunk doc).
 *
 * Deterministic: the same FNV-1a basis-vector embedder (det-embed.ts) seeds
 * chunk vectors and is injected as the query embedder, with intent overridden
 * and expansion/cache disabled.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import {
  writeDocumentTransaction,
  type ChunkWrite,
} from "../src/core/indexer-tx.ts";
import { hybridSearch } from "../src/core/search/index.ts";
import { keywordSearch } from "../src/core/search/keyword.ts";
import { deterministicEmbed, deterministicEmbedQuery } from "./det-embed.ts";

const K = 5;
const HIT_RANK = 3; // Hit@3

type Family = "body_term" | "alias_synonym" | "multi_chunk_dilution";

interface Doc {
  id: string;
  chunks: string[]; // one entry per chunk
}

const CORPUS: Doc[] = [
  { id: "doc_alpha", chunks: ["alpha keyword unique distinctive content here"] },
  { id: "doc_beta", chunks: ["beta separate vocabulary terms paragraph"] },
  // alias_synonym target — reachable ONLY via the synonym bridge. Body has no
  // token that stems toward the query terms (automobile/servicing/auto/repair),
  // so the keyword arm provably cannot match it (asserted below).
  { id: "doc_auto", chunks: ["car maintenance schedule oil change record"] },
  // multi_chunk_dilution target — the full relevant phrase is in the MIDDLE
  // chunk, bracketed by unrelated chunks.
  {
    id: "doc_manual",
    chunks: [
      "introduction boilerplate generic preamble overview section",
      "the special incantation is xyzzy plugh frobnicate waldo",
      "appendix closing notes unrelated filler references index",
    ],
  },
  // Dilution competitor: shares ONE query token (`frobnicate`) but not the
  // full phrase, so the target's focused multi-term chunk must out-rank it.
  { id: "doc_partial", chunks: ["miscellaneous frobnicate placeholder jotting"] },
  { id: "doc_filler", chunks: ["lorem ipsum dolor sit amet placeholder noise"] },
];

const QRELS: { id: string; family: Family; query: string; relevant: string[] }[] = [
  { id: "alpha", family: "body_term", query: "alpha keyword unique", relevant: ["doc_alpha"] },
  { id: "beta", family: "body_term", query: "beta vocabulary terms", relevant: ["doc_beta"] },
  { id: "automobile", family: "alias_synonym", query: "automobile servicing", relevant: ["doc_auto"] },
  { id: "auto_repair", family: "alias_synonym", query: "auto repair", relevant: ["doc_auto"] },
  { id: "incantation", family: "multi_chunk_dilution", query: "xyzzy plugh frobnicate", relevant: ["doc_manual"] },
];

// Env-overridable per-family Hit@3 floor (default: every family fully hits).
const FLOOR = (() => {
  const raw = process.env["MEMEX_GATE_FAMILY_HIT3"];
  if (raw === undefined || raw.trim() === "") return 1.0;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : 1.0;
})();

const toDocId = (chunkId: string): string => chunkId.replace(/_c\d+$/, "");

let tmp: string;
let storage: Storage;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-retr-fam-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  for (const d of CORPUS) {
    const chunks: ChunkWrite[] = d.chunks.map((text) => ({
      text,
      entities: [],
      embedding: deterministicEmbed(text),
    }));
    await writeDocumentTransaction(
      storage,
      {
        documentId: d.id,
        sourcePath: `/${d.id}.md`,
        title: d.id,
        frontmatter: {},
        embeddingModel: "deterministic-test",
      },
      chunks,
    );
  }
});

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function topDocs(query: string): Promise<string[]> {
  const result = await hybridSearch(storage, query, {
    k: K,
    intent: "topic",
    noExpansion: true,
    noCache: true,
    embedQuery: deterministicEmbedQuery,
  });
  const seen = new Set<string>();
  const docs: string[] = [];
  for (const h of result) {
    const d = toDocId(h.chunkId);
    if (!seen.has(d)) {
      seen.add(d);
      docs.push(d);
    }
  }
  return docs;
}

describe("retrieval-quality gate (per query family, hermetic)", () => {
  it("every family meets its Hit@3 floor", async () => {
    const byFamily = new Map<Family, { hits: number; total: number }>();
    for (const q of QRELS) {
      const docs = await topDocs(q.query);
      const top = docs.slice(0, HIT_RANK);
      const hit = q.relevant.some((r) => top.includes(r)) ? 1 : 0;
      const acc = byFamily.get(q.family) ?? { hits: 0, total: 0 };
      acc.hits += hit;
      acc.total += 1;
      byFamily.set(q.family, acc);
    }
    for (const [family, { hits, total }] of byFamily) {
      const hit3 = hits / total;
      // family name in the message so a regression names the failing mode.
      expect(hit3, `family ${family} Hit@3=${hit3}`).toBeGreaterThanOrEqual(FLOOR);
    }
  });

  it("multi-chunk dilution: the focused chunk out-ranks a partial-match competitor", async () => {
    // doc_manual's middle chunk carries the full phrase; doc_partial shares
    // only `frobnicate`. The target must surface AND beat the competitor —
    // otherwise chunk-grain ranking / per-doc dedup has regressed.
    const docs = await topDocs("xyzzy plugh frobnicate");
    expect(docs.slice(0, HIT_RANK)).toContain("doc_manual");
    const mi = docs.indexOf("doc_manual");
    const pi = docs.indexOf("doc_partial");
    // The competitor must actually participate (else "out-ranks" is vacuous),
    // and the focused full-phrase chunk must beat it.
    expect(mi).toBeGreaterThanOrEqual(0);
    expect(pi).toBeGreaterThanOrEqual(0);
    expect(mi).toBeLessThan(pi);
  });

  it("alias-synonym is a true vector-arm sentinel (keyword fails, vector ranks it #1)", async () => {
    // Differential probe: the keyword/FTS arm shares NO token with doc_auto's
    // body, so it can never return it.
    const kw = await keywordSearch(storage.engine(), "automobile servicing", K);
    expect(kw.map(toDocId)).not.toContain("doc_auto");

    // Assert RANK 1, not merely top-3: doc_auto is the only doc the synonym
    // bridge reaches, so a working vector arm ranks it first. A DEGENERATE
    // vector arm (return-all / constant-vector ties) would leave it ordered by
    // id/insertion, NOT first — so rank-1 is what actually proves the arm works
    // on this tiny corpus (codex finding).
    const docs = await topDocs("automobile servicing");
    expect(docs[0]).toBe("doc_auto");
  });
});
