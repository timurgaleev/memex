/**
 * Hybrid search orchestrator — coordinates the pieces in core/search/*.
 *
 * Pipeline:
 *   1. classify intent (Nova Lite, opt-in cache via heuristics)
 *   2. (parallel) embed query → vector retrieval; keyword retrieval
 *   3. (optional) query expansion → extra keyword passes
 *   4. RRF fuse all retrieval lists
 *   5. hydrate top-(k * 3) chunks with parent doc + source kind
 *   6. apply source-boost
 *   7. dedup per documentId (skipped for `exact` intent)
 *   8. (opt-in) two-pass Haiku rerank if MEMEX_RERANK=1
 *   9. trim to k
 *
 * The exported `hybridSearch(storage, query, k)` API stays compatible
 * with existing callers (commands/search.ts, mcp/dispatch.ts).
 * Internal rewiring only.
 */
import type { Storage } from "../storage.ts";
import type { SourceKind } from "../sources.ts";
import { embedText } from "../embedding.ts";
import { reciprocalRankFusion } from "../rrf.ts";
import { vectorSearch } from "./vector.ts";
import { keywordSearch } from "./keyword.ts";
import { dedupByDocument, type ChunkScore } from "./dedup.ts";
import {
  applySourceBoost,
  type BoostablePayload,
} from "./source-boost.ts";
import { classifyIntent, type Intent } from "./intent.ts";
import { rrfWeightsForLists } from "./intent-weights.ts";
import { recencyMultiplier } from "./recency.ts";
import { applyTokenBudget } from "./token-budget.ts";
import {
  getCachedQuery,
  putCachedQuery,
  queryCacheKey,
} from "./query-cache.ts";
import { currentDocumentClock } from "../generation.ts";
import type { Engine } from "../engine/interface.ts";
import { expandQuery } from "./expansion.ts";
import { rerank, type ChunkPayloadForRerank } from "./two-pass.ts";

export interface SearchOptions {
  k?: number;
  embeddingModel?: string;
  rrfK?: number;
  /** Restrict to specific sources by id. */
  sourceIds?: readonly string[];
  /** Override MEMEX_RERANK. */
  rerank?: boolean;
  /** Override Nova Lite intent classification — for tests / cheap fallback. */
  intent?: Intent;
  /** Skip query expansion. */
  noExpansion?: boolean;
  /** Disable the exact-match query cache for this call (default: enabled). */
  noCache?: boolean;
  /**
   * Optional cap on the total estimated tokens (chars/4) of returned
   * `content`, consumed in rank order. The first hit is always kept
   * (truncated if it alone exceeds the budget); the overflowing tail hit
   * is truncated and iteration stops. Unset = no cap.
   */
  tokenBudget?: number;
  /**
   * Optional side-channel: invoked once after results are computed,
   * with the raw query + result IDs + latency + meta. Used by the
   * eval-capture wiring in dispatchers; never blocks user-visible
   * output (callback is awaited but errors are swallowed by the
   * caller).
   */
  onCapture?: (info: SearchCaptureInfo) => Promise<void> | void;
}

export interface SearchCaptureInfo {
  query: string;
  k: number;
  resultDocIds: string[];
  intent: Intent;
  latencyMs: number;
  rerank: boolean;
  expansion: boolean;
}

export interface SearchHit {
  chunkId: string;
  documentId: string;
  sourcePath: string;
  title: string | null;
  content: string;
  score: number;
  intent: Intent;
  /** Set when `content` was cut to fit a `tokenBudget` (trailing "…"). */
  truncated?: boolean;
}

const EMBED_MODEL = "amazon.titan-embed-text-v2:0";

interface HitPayload extends BoostablePayload, ChunkPayloadForRerank {
  /** Live-model content freshness (documents.updated_at), for recency. */
  updated_at?: string | null;
}

/**
 * Hydrate a cached list of chunk ids back into SearchHits, preserving the
 * cached order. Chunks that no longer exist are silently skipped, so a
 * cache hit can never resurrect deleted content. Scores are synthetic
 * (descending by rank) — the ranking decision was already made at cache
 * write time.
 */
async function hydrateByIds(
  engine: Engine,
  ids: readonly string[],
  intent: Intent,
): Promise<SearchHit[]> {
  if (ids.length === 0) return [];
  const rows = await engine.query<{
    id: string;
    document_id: string;
    content: string;
    source_path: string;
    title: string | null;
  }>(
    `SELECT c.id, c.document_id, c.content, d.source_path, d.title
       FROM chunks c
       JOIN documents d ON d.id = c.document_id
      WHERE c.id = ANY($1::text[])`,
    [ids],
  );
  const byId = new Map(rows.rows.map((r) => [r.id, r]));
  const out: SearchHit[] = [];
  let score = ids.length;
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) {
      score--;
      continue;
    }
    out.push({
      chunkId: row.id,
      documentId: row.document_id,
      sourcePath: row.source_path,
      title: row.title,
      content: row.content,
      score: score--,
      intent,
    });
  }
  return out;
}

export async function hybridSearch(
  storage: Storage,
  query: string,
  optsOrK: SearchOptions | number = {},
): Promise<SearchHit[]> {
  const opts: SearchOptions =
    typeof optsOrK === "number" ? { k: optsOrK } : optsOrK;
  const trimmed = (query ?? "").trim();
  if (!trimmed) {
    throw new Error("hybridSearch: query must be non-empty");
  }
  const startedAt = Date.now();
  const k = opts.k ?? 10;
  const fanout = Math.max(20, k * 3);
  const engine = storage.engine();

  // 0. Exact-match query cache (fail-open). A hit skips intent + embed +
  //    retrieval + fusion entirely. Validity is gated on the live-model
  //    generation clock, so any document write invalidates it. Any cache
  //    error falls through to a normal search — the cache is pure
  //    optimization and must never break retrieval.
  const rerankWanted = opts.rerank ?? process.env.MEMEX_RERANK === "1";
  const cacheEnabled = !opts.noCache && process.env.MEMEX_QUERY_CACHE !== "0";
  let cacheKey = "";
  let cacheClock = 0;
  let cacheReady = false;
  if (cacheEnabled) {
    try {
      cacheClock = await currentDocumentClock(engine);
      cacheKey = queryCacheKey(trimmed, k, opts.sourceIds, rerankWanted);
      const cached = await getCachedQuery(engine, cacheKey, cacheClock);
      cacheReady = true;
      if (cached) {
        const cachedIntent = (cached.intent as Intent) ?? "topic";
        const hydrated = await hydrateByIds(engine, cached.resultIds, cachedIntent);
        const hits =
          opts.tokenBudget !== undefined
            ? applyTokenBudget(hydrated, opts.tokenBudget)
            : hydrated;
        if (opts.onCapture) {
          try {
            await opts.onCapture({
              query: trimmed,
              k,
              resultDocIds: hits.map((h) => h.documentId),
              intent: cachedIntent,
              latencyMs: Date.now() - startedAt,
              rerank: rerankWanted,
              expansion: false,
            });
          } catch {
            // capture failures never surface
          }
        }
        return hits;
      }
    } catch {
      cacheReady = false; // fall through to a normal search
    }
  }

  // 1. Intent (cheap heuristic + Nova Lite). Allow override for tests.
  const intent = opts.intent ?? (await classifyIntent(trimmed));

  // 2. Embed + parallel retrieval. Keyword needs the original query;
  //    expansion produces additional keyword passes.
  const queryVector = await embedText(trimmed, {
    modelId: opts.embeddingModel ?? EMBED_MODEL,
  });

  const [vectorIds, primaryKeywordIds] = await Promise.all([
    vectorSearch(engine, queryVector, fanout, {
      sourceIds: opts.sourceIds,
    }),
    keywordSearch(engine, trimmed, fanout, {
      sourceIds: opts.sourceIds,
    }),
  ]);

  // 3. Expansion (skip for exact intent or when caller opted out).
  const lists: string[][] = [vectorIds, primaryKeywordIds];
  if (intent !== "exact" && !opts.noExpansion) {
    const variants = await expandQuery(trimmed, { max: 3 });
    if (variants.length > 0) {
      const extra = await Promise.all(
        variants.map((v) =>
          keywordSearch(engine, v, fanout, { sourceIds: opts.sourceIds }),
        ),
      );
      lists.push(...extra);
    }
  }

  // 4. RRF fuse — weighted by intent (list order is [vector, keyword,
  //    ...keywordExpansions], so keyword lists = lists.length - 1).
  const rrfWeights = rrfWeightsForLists(intent, lists.length - 1);
  const fused = reciprocalRankFusion(lists, {
    k: opts.rrfK,
    weights: rrfWeights,
  }).slice(0, fanout);
  if (fused.length === 0) return [];

  // 5. Hydrate.
  const ids = fused.map((f) => f.id);
  const rows = await engine.query<{
    id: string;
    document_id: string;
    content: string;
    source_path: string;
    title: string | null;
    source_id: string | null;
    source_kind: SourceKind | null;
    updated_at: string | null;
  }>(
    `SELECT c.id, c.document_id, c.content,
            d.source_path, d.title,
            d.source_id,
            s.kind AS source_kind,
            d.updated_at::text AS updated_at
     FROM chunks c
     JOIN documents d ON d.id = c.document_id
     LEFT JOIN sources s ON s.id = d.source_id
     WHERE c.id = ANY($1::text[])`,
    [ids],
  );
  const byId = new Map(rows.rows.map((r) => [r.id, r]));

  let scored: ChunkScore<HitPayload>[] = [];
  for (const f of fused) {
    const row = byId.get(f.id);
    if (!row) continue;
    scored.push({
      chunkId: row.id,
      documentId: row.document_id,
      score: f.score,
      payload: {
        content: row.content,
        title: row.title,
        sourcePath: row.source_path,
        source_id: row.source_id,
        source_kind: row.source_kind,
        updated_at: row.updated_at,
      },
    });
  }

  // 6. Source-boost.
  scored = applySourceBoost(scored);

  // 6b. Recency — gentle freshness multiplier on the LIVE model's
  //     documents.updated_at (floor-bounded, never buries old hits).
  //     Immutable like the rest of the pipeline.
  const nowMs = Date.now();
  scored = scored.map((s) => ({
    ...s,
    score: s.score * recencyMultiplier(s.payload?.updated_at ?? null, nowMs),
  }));

  // Re-sort after boost + recency (RRF was already sorted but these flip).
  scored.sort((a, b) => b.score - a.score);

  // 7. Dedup per doc — skip for `exact` intent.
  const deduped =
    intent === "exact"
      ? scored
      : dedupByDocument(scored, { enabled: true, maxPerDoc: 1 });

  // 8. Two-pass rerank (opt-in).
  const final = rerankWanted
    ? await rerank(trimmed, deduped.slice(0, k * 2))
    : deduped;

  // 9. Trim to k (the ranked result, pre-token-budget).
  const ranked: SearchHit[] = final.slice(0, k).map((h) => ({
    chunkId: h.chunkId,
    documentId: h.documentId,
    sourcePath: h.payload?.sourcePath ?? "",
    title: h.payload?.title ?? null,
    content: h.payload?.content ?? "",
    score: h.score,
    intent,
  }));

  // 9a. Populate the query cache (fire-and-forget) with the ranked chunk
  //     ids at the clock value read on entry. A clock that advanced mid-
  //     search makes this write immediately stale (never read) — harmless.
  if (cacheReady) {
    void putCachedQuery(
      engine,
      cacheKey,
      trimmed,
      k,
      intent,
      ranked.map((h) => h.chunkId),
      cacheClock,
    ).catch(() => {});
  }

  // 9b. Token budget (opt-in) — cap total returned context size.
  let hits: SearchHit[] = ranked;
  if (opts.tokenBudget !== undefined) {
    hits = applyTokenBudget(hits, opts.tokenBudget);
  }

  // 10. Side-channel: optional capture hook for eval-capture wiring.
  // Errors here never affect the user-visible result — wrapped in a
  // try/catch so a failed INSERT can't poison search.
  if (opts.onCapture) {
    try {
      await opts.onCapture({
        query: trimmed,
        k,
        resultDocIds: hits.map((h) => h.documentId),
        intent,
        latencyMs: Date.now() - startedAt,
        rerank: rerankWanted,
        expansion: intent !== "exact" && !opts.noExpansion,
      });
    } catch {
      // Capture failures must not surface; classifier in eval-capture
      // already categorises them for the caller's logging.
    }
  }

  return hits;
}
