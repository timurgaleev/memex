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
import { visibilityClause } from "../visibility.ts";
import {
  dedupByDocument,
  dedupByTextSimilarity,
  getNearDupThreshold,
  type ChunkScore,
} from "./dedup.ts";
import {
  applySourceBoost,
  type BoostablePayload,
} from "./source-boost.ts";
import { classifyIntent, type Intent } from "./intent.ts";
import { rrfWeightsForLists } from "./intent-weights.ts";
import {
  recencyMultiplierForPath,
  resolveRecencyDecayMap,
} from "./recency.ts";
import { salienceMultiplier } from "./salience.ts";
import { isTitlePhraseMatch, getTitleBoost } from "./title-match.ts";
import {
  resolveAdaptiveReturn,
  applyAdaptiveReturn,
  type AdaptiveReturnInput,
} from "./return-policy.ts";
import { applyTokenBudget } from "./token-budget.ts";
import {
  stampEvidence,
  stampDefaultEvidence,
  type Evidence,
  type CreateSafety,
} from "./evidence.ts";
import {
  getCachedQuery,
  putCachedQuery,
  queryCacheKey,
} from "./query-cache.ts";
import { currentDocumentClock } from "../generation.ts";
import type { Engine } from "../engine/interface.ts";
import { expandQuery } from "./expansion.ts";
import { rerank, type ChunkPayloadForRerank } from "./two-pass.ts";
import { applyGraphSignals } from "./graph-signals.ts";

// Recency decay map resolved once per process (defaults ∪ MEMEX_RECENCY_DECAY).
// Memoized so the env parse + its fail-loud validation runs on the first
// search, not on every query.
let _recencyDecayMap: ReturnType<typeof resolveRecencyDecayMap> | null = null;
function getRecencyDecayMap(): ReturnType<typeof resolveRecencyDecayMap> {
  return (_recencyDecayMap ??= resolveRecencyDecayMap());
}

// Title-boost factor: memoized in title-match.ts (single source shared with the
// query-cache ranking signature) so the key and the ranking can never diverge.

export interface SearchOptions {
  k?: number;
  embeddingModel?: string;
  /**
   * Optional query-embedder injection. Defaults to the real Titan embedder;
   * set ONLY by hermetic tests to drive the vector arm with deterministic
   * vectors (no Bedrock). Production never passes this.
   */
  embedQuery?: (text: string) => Promise<number[]>;
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
   * Opt-in adaptive return-sizing (default OFF): trim the returned list to an
   * intent-driven cap. `true` enables the defaults; a partial object overrides
   * the caps. Applied as the final view AFTER the query cache has stored the
   * full ranked set, so it never poisons a later adaptive-off lookup. See
   * return-policy.ts.
   */
  adaptiveReturn?: AdaptiveReturnInput;
  /**
   * Optional side-channel: invoked once after results are computed,
   * with the raw query + result IDs + latency + meta. Used by the
   * eval-capture wiring in dispatchers; never blocks user-visible
   * output (callback is awaited but errors are swallowed by the
   * caller).
   */
  onCapture?: (info: SearchCaptureInfo) => Promise<void> | void;
  /**
   * Opt-in graph-signals stage (default OFF): adjacency hub boost + session
   * diversification over the link graph. Falls back to MEMEX_GRAPH_SIGNALS=1.
   * The live ranking model is immutable unless this is set. See graph-signals.ts.
   */
  graphSignals?: boolean;
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
  /** Why this hit matched (arm-membership signal) — see evidence.ts. */
  evidence?: Evidence;
  /** Derived don't-duplicate hint for the agent — see evidence.ts. */
  create_safety?: CreateSafety;
}

const EMBED_MODEL = "amazon.titan-embed-text-v2:0";

interface HitPayload extends BoostablePayload, ChunkPayloadForRerank {
  /** Live-model content freshness (documents.updated_at), for recency. */
  updated_at?: string | null;
  /** Document frontmatter (documents.frontmatter), for salience. */
  frontmatter?: unknown;
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
    // Visibility filter here too (belt-and-suspenders): a cached query can
    // re-hydrate ids captured before a doc was soft-deleted/archived/
    // quarantined. The column-flip ops bump per-doc generation to invalidate
    // Layer-2, but filtering at hydrate guarantees a hidden doc never surfaces
    // even if an invalidation is ever missed.
    `SELECT c.id, c.document_id, c.content, d.source_path, d.title
       FROM chunks c
       JOIN documents d ON d.id = c.document_id
      WHERE c.id = ANY($1::text[])
        AND ${visibilityClause("d")}`,
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
  // Adaptive return-sizing (opt-in, default OFF). Resolved once; applied as the
  // final view on BOTH return paths, after the cache has stored the full set.
  const adaptiveCfg = resolveAdaptiveReturn(opts.adaptiveReturn);

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
        // Cache hits have no arm membership to classify — stamp the
        // conservative default so the evidence contract is uniform (always
        // present) and never a false `exists`. A title-phrase match is still
        // computable from the hit title, so a cached title hit surfaces
        // `exact_title_match` rather than a flat `weak_semantic`.
        stampDefaultEvidence(hits, trimmed);
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
        // Adaptive return-sizing (opt-in, default OFF) — the FINAL view, applied
        // after the cache read served the full stored set and after capture saw
        // it, so the cap never poisons the cache or shrinks the eval window.
        return applyAdaptiveReturn(hits, cachedIntent, adaptiveCfg).kept;
      }
    } catch {
      cacheReady = false; // fall through to a normal search
    }
  }

  // 1. Intent (cheap heuristic + Nova Lite). Allow override for tests.
  const intent = opts.intent ?? (await classifyIntent(trimmed));

  // 2. Embed + parallel retrieval. Keyword needs the original query;
  //    expansion produces additional keyword passes. `embedQuery` is an
  //    optional injection seam: when set it replaces the Bedrock embedder,
  //    letting a hermetic test drive the vector arm with deterministic vectors.
  //    Unset (the only production path) → the real Titan embedder, unchanged.
  const queryVector = opts.embedQuery
    ? await opts.embedQuery(trimmed)
    : await embedText(trimmed, {
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
    frontmatter: unknown;
  }>(
    `SELECT c.id, c.document_id, c.content,
            d.source_path, d.title,
            d.source_id,
            s.kind AS source_kind,
            d.updated_at::text AS updated_at,
            d.frontmatter
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
        frontmatter: row.frontmatter,
      },
    });
  }

  // 6. Source-boost.
  scored = applySourceBoost(scored);

  // 6b. Recency (documents.updated_at) + salience (frontmatter pinned/weight)
  //     — gentle post-fusion multipliers on the LIVE model. Immutable like
  //     the rest of the pipeline; both are neutral (1.0) when their signal
  //     is absent, so neither can bury a hit that doesn't declare it.
  const nowMs = Date.now();
  // Per-prefix recency decay (env-overridable); paths matching no prefix
  // (e.g. code chunks under `src/`) fall back to the original uniform decay.
  // Memoized: resolved once per process, so the env parse (and its fail-loud
  // validation) runs on the first search rather than on every query.
  const recencyMap = getRecencyDecayMap();
  // Title-phrase boost: when the query is a contiguous phrase in the page
  // title, nudge the score up by a scale-invariant factor. A name-of-thing
  // query should surface the page over a weak body chunk. Neutral (×1) for
  // every hit whose title doesn't match, so it can never bury a non-matching
  // hit; inert entirely when MEMEX_TITLE_BOOST <= 1.0.
  const titleBoost = getTitleBoost();
  const titleBoostActive = Number.isFinite(titleBoost) && titleBoost > 1.0;
  scored = scored.map((s) => ({
    ...s,
    score:
      s.score *
      recencyMultiplierForPath(
        s.payload?.updated_at ?? null,
        nowMs,
        s.payload?.sourcePath ?? null,
        recencyMap,
      ) *
      salienceMultiplier(s.payload?.frontmatter) *
      (titleBoostActive && isTitlePhraseMatch(trimmed, s.payload?.title)
        ? titleBoost
        : 1),
  }));

  // 6c. Graph signals (opt-in, default OFF) — adjacency hub boost + session
  //     diversification over the link graph, applied pre-dedup on the full
  //     scored set so a hub's chunk can rise before per-doc collapse. Mutates
  //     score in place; fail-open (a links query error leaves scores intact).
  const graphSignalsOn =
    opts.graphSignals ?? process.env.MEMEX_GRAPH_SIGNALS === "1";
  if (graphSignalsOn) {
    await applyGraphSignals(scored, engine, { enabled: true });
  }

  // Re-sort after boost + recency (RRF was already sorted but these flip).
  scored.sort((a, b) => b.score - a.score);

  // 7. Per-document dedup (one chunk per document) — skip for `exact` intent
  //    ("show me everything about this note").
  const perDoc =
    intent === "exact"
      ? scored
      : dedupByDocument(scored, { enabled: true, maxPerDoc: 1 });

  // 8. Two-pass rerank (opt-in) — runs BEFORE near-dup so the reranker sees
  //    both near-identical twins and decides their order; near-dup then drops
  //    the now-lower-ranked one (the reranker can't undo a drop, so it must
  //    come first).
  const reranked = rerankWanted
    ? await rerank(trimmed, perDoc.slice(0, k * 2))
    : perDoc;

  // 8b. Near-dup dedup across documents (Jaccard on text) — two DIFFERENT docs
  //     can still carry near-identical text (a note + its `.bak`); drop the
  //     lower-ranked twin. Applied AFTER rerank, skipped for `exact` intent or
  //     when MEMEX_NEARDUP_JACCARD > 1.0.
  let final = reranked;
  if (intent !== "exact") {
    const ndThreshold = getNearDupThreshold();
    if (ndThreshold <= 1.0) final = dedupByTextSimilarity(reranked, ndThreshold);
  }

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

  // 9·evidence — stamp WHY each hit matched (which retrieval arm(s) surfaced
  //     it) + a conservative create_safety hint for the agent. Pure-additive:
  //     it does NOT reorder. (The cache-hit short-circuit stamps the
  //     conservative default earlier, so the contract is uniform.)
  //     The arm sets are the PRIMARY (un-expanded) vector + keyword passes by
  //     design: `keyword_exact` means the original query terms matched, not an
  //     LLM expansion paraphrase. Do NOT widen these to the expansion keyword
  //     lists — that would loosen the `exists` gate on paraphrase-only hits.
  //     A hit surfaced only by an expansion pass classifies weak_semantic
  //     (conservative, never a false `exists`).
  stampEvidence(ranked, new Set(vectorIds), new Set(primaryKeywordIds), trimmed);

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
      // Distinct documents the result chunks belong to → the Layer 2
      // per-document generation snapshot (migration 031). A later write to a
      // doc NOT in this set leaves the cached row servable.
      [...new Set(ranked.map((h) => h.documentId))],
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

  // 11. Adaptive return-sizing (opt-in, default OFF) — the FINAL step. Applied
  //     after the cache write (9a stored the full `ranked` set) AND after the
  //     eval-capture hook (which records the full returned candidate set), so
  //     the cap is a pure view on the returned value: it never poisons the
  //     cache and never shrinks the eval window. Default OFF → `hits` unchanged.
  return applyAdaptiveReturn(hits, intent, adaptiveCfg).kept;
}
