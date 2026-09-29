/**
 * Tier-1 items 5 + 6: filter pushdown + two free ranking signals.
 *
 *  5. FILTER PUSHDOWN — lang / symbol_kind / since / until are folded into the
 *     keyword (ts_rank_cd) and vector (pgvector) WHERE clauses, so the per-arm
 *     LIMIT budget is spent on already-matching rows. A filtered match ranking
 *     below the fanout is no longer dropped.
 *  6a. BACKLINK-COUNT BOOST — ×(1 + 0.05·ln(1+in_degree)) from the GLOBAL links
 *      in-degree, floor-gated like graph-signals.
 *  6b. COSINE RE-SCORE — 0.7·normRRF + 0.3·cosine before dedup, so a
 *      semantically-closer chunk survives per-doc collapse.
 *
 * Hermetic: deterministic embedder, direct SQL seeds, no Bedrock.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { writeDocumentTransaction } from "../src/core/indexer-tx.ts";
import { hybridSearch } from "../src/core/search/index.ts";
import { keywordSearch } from "../src/core/search/keyword.ts";
import { vectorSearch } from "../src/core/search/vector.ts";
import {
  applyBacklinkBoost,
  defaultBacklinkCounts,
  BACKLINK_BOOST_COEF,
  type BacklinkScorable,
} from "../src/core/search/backlink-boost.ts";
import { cosineReScore } from "../src/core/search/cosine-rescore.ts";
import type { ChunkScore } from "../src/core/search/dedup.ts";
import { deterministicEmbed, deterministicEmbedQuery } from "./det-embed.ts";

setDefaultTimeout(30000);

const toDocId = (chunkId: string): string => chunkId.replace(/_c\d+$/, "");
const noEngine = {} as never;

let tmp: string;
let storage: Storage;

async function writeDoc(
  documentId: string,
  content: string,
  extra: { language?: string; symbolType?: string; date?: string } = {},
): Promise<void> {
  await writeDocumentTransaction(
    storage,
    {
      documentId,
      sourcePath: `/${documentId}.md`,
      title: documentId,
      frontmatter: extra.date ? { date: extra.date } : {},
      embeddingModel: "deterministic-test",
    },
    [
      {
        text: content,
        entities: [],
        embedding: deterministicEmbed(content),
        ...(extra.language ? { language: extra.language } : {}),
        ...(extra.symbolType ? { symbolType: extra.symbolType } : {}),
      },
    ],
  );
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-ranking-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Item 5 — filter pushdown at the retrieval-arm SQL layer.
// ---------------------------------------------------------------------------
describe("filter pushdown — keyword arm", () => {
  const Q = "signal lookup retrieval";
  beforeAll(async () => {
    // Four noise chunks (no language) whose chunk ids sort BEFORE the target,
    // plus one typescript chunk whose id sorts LAST. With equal ts_rank the
    // ORDER BY id tiebreak puts the target dead last.
    for (const id of ["kw_noise_0", "kw_noise_1", "kw_noise_2", "kw_noise_3"]) {
      await writeDoc(id, Q);
    }
    await writeDoc("kw_zzz_ts", Q, { language: "typescript" });
  });

  it("without the filter a small LIMIT drops the low-ranked target", async () => {
    const ids = await keywordSearch(storage.engine(), Q, 2);
    expect(ids).not.toContain("kw_zzz_ts_c0");
  });

  it("with lang pushed down, the same small LIMIT returns the target", async () => {
    const ids = await keywordSearch(storage.engine(), Q, 2, {
      filters: { lang: "typescript" },
    });
    expect(ids).toEqual(["kw_zzz_ts_c0"]);
  });
});

describe("filter pushdown — vector arm", () => {
  // Noise chunks share the query vocabulary (near-zero cosine distance);
  // the typescript target is disjoint vocabulary (far), so it ranks LAST.
  const QV = "orange purple crimson indigo";
  beforeAll(async () => {
    for (const id of ["vec_noise_0", "vec_noise_1", "vec_noise_2", "vec_noise_3"]) {
      await writeDoc(id, QV);
    }
    // Distinct language ("rust") so this arm's filter can't collide with the
    // keyword arm's typescript target in the shared DB.
    await writeDoc("vec_zzz_ts", "zeta", { language: "rust" });
  });

  it("without the filter a small LIMIT drops the far (low-ranked) target", async () => {
    const ids = await vectorSearch(storage.engine(), deterministicEmbed(QV), 2);
    expect(ids).not.toContain("vec_zzz_ts_c0");
  });

  it("with lang pushed down, the same small LIMIT returns the target", async () => {
    const ids = await vectorSearch(storage.engine(), deterministicEmbed(QV), 2, {
      filters: { lang: "rust" },
    });
    expect(ids).toEqual(["vec_zzz_ts_c0"]);
  });
});

describe("filter pushdown — hybridSearch end-to-end (since)", () => {
  const HQ = "beacon telemetry gauge";
  beforeAll(async () => {
    // 32 recent noise docs (> the fanout of max(20,k*3)=30) whose chunk ids sort
    // before the target, and one OLD-but-matching target. Pre-pushdown the
    // target ranks ~33rd — beyond the fanout — so a since filter applied after
    // hydrate would never see it. Pushed down, the keyword arm returns only the
    // dated match.
    for (let i = 0; i < 32; i++) {
      await writeDoc(`h_noise_${String(i).padStart(2, "0")}`, HQ, { date: "2024-01-01" });
    }
    await writeDoc("h_zzz_old", HQ, { date: "2018-06-01" });
  });

  it("returns a matching doc that ranks below the fanout", async () => {
    // Keyword-only (throwing embedder → queryVector=null) keeps ordering fully
    // deterministic via the id tiebreak.
    const hits = await hybridSearch(storage, HQ, {
      k: 10,
      intent: "topic",
      noExpansion: true,
      embedQuery: async () => {
        throw new Error("force keyword-only");
      },
      until: "2019-01-01",
    });
    const docs = hits.map((h) => toDocId(h.chunkId));
    expect(docs).toContain("h_zzz_old");
  });
});

// ---------------------------------------------------------------------------
// Item 6a — backlink-count boost.
// ---------------------------------------------------------------------------
describe("applyBacklinkBoost (pure scoring, injected counts)", () => {
  const scorable = (sourcePath: string, score: number): BacklinkScorable => ({
    score,
    payload: { sourcePath },
  });

  it("multiplies by 1 + COEF·ln(1+count) and leaves 0-count hits untouched", async () => {
    const hits = [scorable("page://plain", 1.0), scorable("page://hub", 0.9)];
    await applyBacklinkBoost(hits, noEngine, {
      countFn: async () => new Map([["hub", 10]]),
    });
    expect(hits[0]!.score).toBe(1.0);
    expect(hits[1]!.score).toBeCloseTo(0.9 * (1 + BACKLINK_BOOST_COEF * Math.log(11)), 10);
  });

  it("can flip ordering — a well-linked runner-up overtakes a link-less leader", async () => {
    const hits = [scorable("page://leader", 1.0), scorable("page://hub", 0.98)];
    await applyBacklinkBoost(hits, noEngine, {
      countFn: async () => new Map([["hub", 50]]),
    });
    expect(hits[1]!.score).toBeGreaterThan(hits[0]!.score);
  });

  it("skips hits below the floor threshold", async () => {
    const hits = [scorable("page://strong", 1.0), scorable("page://weak", 0.1)];
    await applyBacklinkBoost(hits, noEngine, {
      floorThreshold: 0.5,
      countFn: async () => new Map([["strong", 5], ["weak", 5]]),
    });
    expect(hits[0]!.score).toBeCloseTo(1.0 * (1 + BACKLINK_BOOST_COEF * Math.log(6)), 10);
    expect(hits[1]!.score).toBe(0.1); // sub-floor → untouched
  });

  it("is a no-op on an empty list", async () => {
    await applyBacklinkBoost([], noEngine, { countFn: async () => new Map() });
  });
});

describe("defaultBacklinkCounts (global in-degree over links)", () => {
  beforeAll(async () => {
    const db = storage.raw();
    await db.exec(`
      INSERT INTO pages (slug, type, content_hash) VALUES
        ('hub', 'note', 'h'),
        ('src-a', 'note', 'a'),
        ('src-b', 'note', 'b'),
        ('src-c', 'note', 'c');
      INSERT INTO links (source_slug, target_slug, type, link_source) VALUES
        ('src-a', 'hub', 'wikilink',   'markdown'),
        ('src-b', 'hub', 'related_to', 'frontmatter'),
        ('src-c', 'hub', 'mentions',   'mentions'),
        ('hub',   'hub', 'wikilink',   'markdown');
    `);
  });

  it("counts distinct inbound source pages, excluding mentions and self-links", async () => {
    const counts = await defaultBacklinkCounts(storage.engine(), ["hub"]);
    // src-a + src-b count; the 'mentions' row (src-c) and the self-link are out.
    expect(counts.get("hub")).toBe(2);
  });

  it("returns an empty map for an unknown slug", async () => {
    const counts = await defaultBacklinkCounts(storage.engine(), ["nope"]);
    expect(counts.get("nope")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Item 6b — cosine re-score blend.
// ---------------------------------------------------------------------------
describe("cosineReScore (blend before dedup)", () => {
  beforeAll(async () => {
    // cos_high shares the query vector exactly (cosine 1); cos_low shares only
    // one term (low cosine). RRF initially favors cos_low.
    await writeDoc("cos_high", "alpha beta");
    await writeDoc("cos_low", "alpha theta iota kappa lambda mu nu xi omicron pi");
  });

  it("blends 0.7·normRRF + 0.3·cosine and flips a semantically-closer chunk up", async () => {
    const scored: ChunkScore<Record<string, never>>[] = [
      { chunkId: "cos_low_c0", documentId: "cos_low", score: 0.05, payload: {} },
      { chunkId: "cos_high_c0", documentId: "cos_high", score: 0.04, payload: {} },
    ];
    await cosineReScore(scored, storage.engine(), deterministicEmbed("alpha beta"));
    // cos_high: normRRF = 0.04/0.05 = 0.8, cosine = 1 → 0.7·0.8 + 0.3·1 = 0.86.
    const high = scored.find((s) => s.chunkId === "cos_high_c0")!;
    const low = scored.find((s) => s.chunkId === "cos_low_c0")!;
    expect(high.score).toBeCloseTo(0.86, 5);
    expect(high.score).toBeGreaterThan(low.score); // ordering flipped
  });
});
