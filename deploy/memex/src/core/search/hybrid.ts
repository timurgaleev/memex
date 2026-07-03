/**
 * Hybrid search orchestrator — coordinates the pieces in core/search/*.
 *
 * Pipeline:
 *   1. classify intent (Claude Haiku, opt-in cache via heuristics)
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
import { isCanonicalQuery } from "./recency-gate.ts";
import {
  getCurationBoostMap,
  curationMultiplierForPath,
  getSearchExcludePrefixes,
  isExcludedPath,
} from "./curation.ts";
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
  getSemanticCachedQuery,
  putCachedQuery,
  queryCacheKey,
  queryCacheBucketKey,
  resolveSemanticCacheConfig,
  type CachedQuery,
} from "./query-cache.ts";
import { stampContentFlags, type ContentFlag } from "./content-flag.ts";
import { currentDocumentClock } from "../generation.ts";
import type { Engine } from "../engine/interface.ts";
import { expandQuery } from "./expansion.ts";
import { rerank, type ChunkPayloadForRerank } from "./two-pass.ts";
import { graphRerank } from "./graph-rerank.ts";
import {
  applyGraphSignals,
  computeFloorThreshold,
  getGraphSignalsFloorRatio,
} from "./graph-signals.ts";
import { applyAliasHop, aliasHopEnabled } from "./alias-hop.ts";
import { expandAnchors } from "./structural-expand.ts";
import { applyBacklinkBoost } from "./backlink-boost.ts";
import { cosineReScore } from "./cosine-rescore.ts";
import type { ChunkFilters } from "./filters.ts";

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
  /**
   * Opt-in graph-aware Sonnet rerank (default OFF; falls back to
   * MEMEX_GRAPH_RERANK=1). POST-FUSION: reorders the top hits with one paid
   * Sonnet call, given each hit's excerpt + a link-graph connectivity hint.
   * Fail-open — any error/budget-skip returns the pre-rerank order. Distinct
   * from `rerank` (the Haiku two-pass text reranker). See graph-rerank.ts.
   */
  graphRerank?: boolean;
  /** Override Claude Haiku intent classification — for tests / cheap fallback. */
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
  /**
   * Backlink-count boost (default ON): multiply each hit by
   * 1 + 0.05*ln(1+inbound_link_count) using the page's GLOBAL in-degree from the
   * `links` table, floor-ratio-gated like graph-signals. Deterministic + cheap
   * (one links tally). Falls back to MEMEX_BACKLINK_BOOST !== "0". Set false /
   * MEMEX_BACKLINK_BOOST=0 to disable. See backlink-boost.ts.
   */
  backlinkBoost?: boolean;
  /**
   * Cosine re-score blend (default OFF): before dedup, re-score each candidate
   * as 0.7*normalizedRRF + 0.3*(query·chunk cosine) so semantically-closer
   * chunks survive the per-doc collapse. Adds one embeddings fetch per query.
   * Falls back to MEMEX_COSINE_RESCORE === "1". Inert on the keyword-only
   * fallback (no query vector). See cosine-rescore.ts.
   */
  cosineRescore?: boolean;
  /** Filter to chunks of a given source language (chunks.language, e.g. "typescript"). */
  lang?: string;
  /** Filter to chunks of a given symbol kind (chunks.symbol_type, e.g. "function"). */
  symbolKind?: string;
  /** Keep only docs whose content date COALESCE(effective_date,updated_at) is >= this ISO date. */
  since?: string;
  /** Keep only docs whose content date COALESCE(effective_date,updated_at) is <= this ISO date. */
  until?: string;
  /**
   * Structural two-pass expansion (default OFF): walk the code call graph
   * `walkDepth` hops (1-2, capped at 2) from the fused anchors over
   * `code_edges_symbol`, scoring neighbors by `anchorScore * 1/(1+hop)`.
   * Code corpora only; inert when no edges exist. See structural-expand.ts.
   */
  walkDepth?: number;
  /**
   * Anchor retrieval at this qualified symbol name — its chunk(s) join the
   * fused anchor set, seeding the structural walk even when the text query
   * matched nothing. Bypasses the query cache like the per-call filters.
   */
  nearSymbol?: string;
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
  /**
   * WARN signal: the page carries a `content_flag` frontmatter marker
   * (markup-heavy / oversize / operator-flagged). Still searchable — this tells
   * the agent to examine the page before trusting it. Absent when clean.
   * Stamped post-fusion by `stampContentFlags`. See content-flag.ts.
   */
  content_flag?: ContentFlag;
}

const EMBED_MODEL = "amazon.titan-embed-text-v2:0";

// Query-embed deadline. The vector arm must never let a slow/stuck Bedrock call
// hold the whole search hostage: the embed runs against a wall-clock budget, and
// on timeout we fall back to keyword-only (embedding failure is non-fatal).
const QUERY_EMBED_TIMEOUT_MS = (() => {
  const n = Number(process.env.MEMEX_QUERY_EMBED_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 6_000;
})();
const MIN_QUERY_EMBED_BUDGET_MS = 2_000;

export interface QueryEmbedDeadline {
  signal: AbortSignal;
  deadlineAt: number;
}

export function makeQueryEmbedDeadline(ms = QUERY_EMBED_TIMEOUT_MS): QueryEmbedDeadline {
  return { signal: AbortSignal.timeout(ms), deadlineAt: Date.now() + ms };
}

/**
 * Embed a query under a wall-clock deadline. Threads the deadline's abort signal
 * into the Bedrock call AND races the promise against a fail-loud timer, so a
 * hung connection that ignores the abort still cannot block past the budget.
 * Returns the vector or throws on deadline; the caller treats a throw as a
 * keyword-only fallback.
 */
export async function embedQueryBounded(
  text: string,
  embedOpts: { embeddingModel?: string } | undefined,
  dl: QueryEmbedDeadline,
): Promise<number[]> {
  const p = embedText(text, {
    modelId: embedOpts?.embeddingModel ?? EMBED_MODEL,
    abortSignal: dl.signal,
  });
  p.catch(() => {});
  const remaining = Math.max(MIN_QUERY_EMBED_BUDGET_MS, dl.deadlineAt - Date.now());
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`query embed deadline ${QUERY_EMBED_TIMEOUT_MS}ms exceeded`)),
      remaining,
    );
  });
  try {
    return await Promise.race([p, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Race an injected embedder (the hermetic `embedQuery` test seam) against the
 * same deadline as `embedQueryBounded`, so the bounded behaviour is identical
 * whether the embed comes from Bedrock or a test injection.
 */
async function raceEmbedderAgainstDeadline(
  embedFn: (text: string) => Promise<number[]>,
  text: string,
  dl: QueryEmbedDeadline,
): Promise<number[]> {
  const p = embedFn(text);
  p.catch(() => {});
  const remaining = Math.max(MIN_QUERY_EMBED_BUDGET_MS, dl.deadlineAt - Date.now());
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`query embed deadline ${QUERY_EMBED_TIMEOUT_MS}ms exceeded`)),
      remaining,
    );
  });
  try {
    return await Promise.race([p, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface HitPayload extends BoostablePayload, ChunkPayloadForRerank {
  /** Live-model content freshness (documents.updated_at), for recency. */
  updated_at?: string | null;
  /** Document frontmatter (documents.frontmatter), for salience. */
  frontmatter?: unknown;
  /** Chunk source language (chunks.language), for the lang filter. */
  language?: string | null;
  /** Chunk symbol kind (chunks.symbol_type), for the symbol_kind filter. */
  symbol_type?: string | null;
  /** Content date COALESCE(effective_date, updated_at), for since/until. */
  effective_date?: string | null;
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
  sourceIds?: readonly string[],
): Promise<SearchHit[]> {
  if (ids.length === 0) return [];
  // Tenant scope (belt-and-suspenders): a cached result-id set can predate a
  // re-scope, so a scoped caller must re-filter on hydrate — the cache key
  // includes the scope, but a stale row keyed before the scope changed could
  // otherwise leak another source's chunk. No-op when unscoped.
  const params: unknown[] = [ids];
  let sourceFilter = "";
  if (sourceIds && sourceIds.length) {
    params.push(sourceIds);
    sourceFilter = ` AND d.source_id = ANY($${params.length}::text[])`;
  }
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
        AND ${visibilityClause("d")}${sourceFilter}`,
    params,
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
  // Resolve the graph-signals floor ratio up-front (memoized, fail-loud) so a
  // malformed MEMEX_GRAPH_SIGNALS_FLOOR surfaces here rather than being
  // swallowed by the cache try-block below — which catches bare and would
  // silently disable caching on every query. rankingSignature() reads the same
  // memoized value inside that block.
  const graphFloorRatio = getGraphSignalsFloorRatio();

  // 0. Exact-match query cache (fail-open). A hit skips intent + embed +
  //    retrieval + fusion entirely. Validity is gated on the live-model
  //    generation clock, so any document write invalidates it. Any cache
  //    error falls through to a normal search — the cache is pure
  //    optimization and must never break retrieval.
  const rerankWanted = opts.rerank ?? process.env.MEMEX_RERANK === "1";
  // Per-call post-hydrate filters (lang / symbol_kind / since / until) are NOT
  // part of the cache key, so a filtered query bypasses the query cache
  // entirely — it never reads a cached unfiltered set nor writes a filtered one.
  const hasFilters = Boolean(
    opts.lang || opts.symbolKind || opts.since || opts.until,
  );
  // Pushed-down filter set (lang / symbol_kind / since / until). Threaded into
  // BOTH retrieval arms so the per-arm LIMIT budget is spent on already-matching
  // rows — a filtered match ranking below the fanout is no longer dropped. The
  // post-hydrate filter (step 5b) still runs as the choke point for structural
  // neighbors, which bypass the retrieval arms. Undefined when no axis is set.
  const chunkFilters: ChunkFilters | undefined = hasFilters
    ? {
        ...(opts.lang ? { lang: opts.lang } : {}),
        ...(opts.symbolKind ? { symbolKind: opts.symbolKind } : {}),
        ...(opts.since ? { since: opts.since } : {}),
        ...(opts.until ? { until: opts.until } : {}),
      }
    : undefined;
  // Structural expansion (near_symbol / walk_depth) widens the candidate set
  // beyond what the query alone produces, so its result must never be served
  // from — nor written to — the exact-match query cache.
  const structural = (opts.walkDepth ?? 0) > 0 || Boolean(opts.nearSymbol);
  const cacheEnabled =
    !opts.noCache &&
    !hasFilters &&
    !structural &&
    process.env.MEMEX_QUERY_CACHE !== "0";
  let cacheKey = "";
  let cacheClock = 0;
  let cacheReady = false;
  // Serve a cache hit (exact or semantic): re-hydrate from the live tables,
  // stamp the uniform evidence + content-flag contract, fire capture, and apply
  // the final adaptive-return view. Shared by both cache arms so they behave
  // identically. `expansion: false` is correct for both — a cache hit
  // short-circuits before the expansion/retrieval stage.
  const serveCachedRanking = async (cached: CachedQuery): Promise<SearchHit[]> => {
    const cachedIntent = (cached.intent as Intent) ?? "topic";
    const hydrated = await hydrateByIds(engine, cached.resultIds, cachedIntent, opts.sourceIds);
    const hits =
      opts.tokenBudget !== undefined
        ? applyTokenBudget(hydrated, opts.tokenBudget)
        : hydrated;
    // Cache hits have no arm membership to classify — stamp the conservative
    // default so the evidence contract is uniform (always present) and never a
    // false `exists`. A title-phrase match is still computable from the hit
    // title, so a cached title hit surfaces `exact_title_match` rather than a
    // flat `weak_semantic`.
    stampDefaultEvidence(hits, trimmed);
    // Same WARN channel on the cache-hit path so the flag is uniform.
    await stampContentFlags(engine, hits);
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
    // after the cache read served the full stored set and after capture saw it,
    // so the cap never poisons the cache or shrinks the eval window.
    return applyAdaptiveReturn(hits, cachedIntent, adaptiveCfg).kept;
  };
  if (cacheEnabled) {
    try {
      cacheClock = await currentDocumentClock(engine);
      cacheKey = queryCacheKey(trimmed, k, opts.sourceIds, rerankWanted);
      const cached = await getCachedQuery(engine, cacheKey, cacheClock);
      cacheReady = true;
      if (cached) return await serveCachedRanking(cached);
    } catch {
      cacheReady = false; // fall through to a normal search
    }
  }

  // 1. Intent (cheap heuristic + Claude Haiku). Allow override for tests.
  const intent = opts.intent ?? (await classifyIntent(trimmed));

  // 2. Embed + parallel retrieval. Keyword needs the original query;
  //    expansion produces additional keyword passes. `embedQuery` is an
  //    optional injection seam: when set it replaces the Bedrock embedder,
  //    letting a hermetic test drive the vector arm with deterministic vectors.
  //    Unset (the only production path) → the real Titan embedder, unchanged.
  //    The embed runs under a wall-clock deadline: a slow/stuck Bedrock call
  //    must never hold the whole search hostage. On timeout (or any embed
  //    error) the vector arm is dropped and we fall back to keyword-only —
  //    embedding failure is non-fatal.
  let queryVector: number[] | null = null;
  const dl = makeQueryEmbedDeadline();
  try {
    queryVector = opts.embedQuery
      ? await raceEmbedderAgainstDeadline(opts.embedQuery, trimmed, dl)
      : await embedQueryBounded(trimmed, { embeddingModel: opts.embeddingModel }, dl);
  } catch {
    queryVector = null; // keyword-only fallback
  }

  // 1b. Semantic query cache (opt-in, default OFF). On an exact-match miss, try
  //     the nearest stored query embedding within the same scope/knobs bucket,
  //     cosine >= threshold, TTL- and freshness-gated. Requires a healthy vector
  //     arm — a degraded/null `queryVector` skips this path (the degraded
  //     ranking must not be borrowed by a paraphrase). Fail-open like the exact
  //     arm: any error falls through to the full search.
  if (cacheReady && queryVector !== null) {
    const semCfg = resolveSemanticCacheConfig();
    if (semCfg.enabled) {
      try {
        const bucket = queryCacheBucketKey(k, opts.sourceIds, rerankWanted);
        const sem = await getSemanticCachedQuery(
          engine,
          bucket,
          queryVector,
          cacheClock,
          semCfg,
        );
        if (sem) return await serveCachedRanking(sem);
      } catch {
        // semantic cache is a pure optimization — fall through to full search
      }
    }
  }

  const [vectorIds, primaryKeywordIds] = await Promise.all([
    queryVector
      ? vectorSearch(engine, queryVector, fanout, {
          sourceIds: opts.sourceIds,
          filters: chunkFilters,
        })
      : Promise.resolve<string[]>([]),
    keywordSearch(engine, trimmed, fanout, {
      sourceIds: opts.sourceIds,
      filters: chunkFilters,
    }),
  ]);

  // 3. Expansion (skip for exact intent or when caller opted out).
  const lists: string[][] = [vectorIds, primaryKeywordIds];
  if (intent !== "exact" && !opts.noExpansion) {
    const variants = await expandQuery(trimmed, { max: 3 });
    if (variants.length > 0) {
      const extra = await Promise.all(
        variants.map((v) =>
          keywordSearch(engine, v, fanout, {
            sourceIds: opts.sourceIds,
            filters: chunkFilters,
          }),
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

  // 4b. Structural two-pass expansion (near_symbol / walk_depth) — default OFF.
  //     Widen the candidate set with code-graph neighbors BEFORE hydrate so the
  //     neighbors flow through the single hydrate + scoring + dedup path. Runs
  //     before the empty-fused short-circuit so a bare `near_symbol` query (no
  //     keyword/vector hit) can still seed anchors. Best-effort: a missing or
  //     empty edge table must never break base retrieval.
  if (structural) {
    try {
      const expanded = await expandAnchors(
        engine,
        fused.map((f) => ({ id: f.id, score: f.score })),
        {
          walkDepth: opts.walkDepth,
          nearSymbol: opts.nearSymbol,
          sourceIds: opts.sourceIds,
        },
      );
      const have = new Set(fused.map((f) => f.id));
      for (const e of expanded) {
        if (!have.has(e.id)) {
          fused.push({ id: e.id, score: e.score });
          have.add(e.id);
        }
      }
    } catch (err) {
      // Structural expansion is optional — fall back to the un-expanded anchors.
      // Log server-side so a real bug in the walk isn't masked as "no neighbors".
      console.warn(`[structural-expand] expansion failed, falling back: ${String(err)}`);
    }
  }

  if (fused.length === 0) return [];

  // 5. Hydrate.
  const ids = fused.map((f) => f.id);
  // Tenant scope: a scoped caller sees only its own sources. The retrieval arms
  // already filter by source, but the structural walk can surface neighbors
  // reached through the (source-agnostic) code edge table, so the hydrate join
  // re-asserts the scope as the single choke point. No-op when unscoped.
  const hydrateParams: unknown[] = [ids];
  let hydrateSourceFilter = "";
  if (opts.sourceIds && opts.sourceIds.length) {
    hydrateParams.push(opts.sourceIds);
    hydrateSourceFilter = ` AND d.source_id = ANY($${hydrateParams.length}::text[])`;
  }
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
    language: string | null;
    symbol_type: string | null;
    effective_date: string | null;
  }>(
    `SELECT c.id, c.document_id, c.content,
            d.source_path, d.title,
            d.source_id,
            s.kind AS source_kind,
            d.updated_at::text AS updated_at,
            d.frontmatter,
            c.language,
            c.symbol_type,
            COALESCE(d.effective_date, d.updated_at)::text AS effective_date
     FROM chunks c
     JOIN documents d ON d.id = c.document_id
     LEFT JOIN sources s ON s.id = d.source_id
     WHERE c.id = ANY($1::text[])${hydrateSourceFilter}`,
    hydrateParams,
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
        language: row.language,
        symbol_type: row.symbol_type,
        effective_date: row.effective_date,
      },
    });
  }

  // 5b. Per-call filters (lang / symbol_kind / since / until). Post-hydrate so
  //     they compose with fusion; the candidate set may shrink below k (filter
  //     semantics — only matching hits are returned). Cache is bypassed when
  //     any filter is set, so this never persists a filtered set.
  if (hasFilters) {
    // Compare dates as epoch ms, NOT strings: Postgres renders TIMESTAMPTZ as
    // "2024-03-15 10:00:00+00" (space separator) while a caller passes ISO
    // ("2024-03-15T…") — a raw string compare would mis-order across that gap.
    const sinceMs = opts.since ? Date.parse(opts.since) : NaN;
    const untilMs = opts.until ? Date.parse(opts.until) : NaN;
    scored = scored.filter((s) => {
      const p = s.payload;
      if (opts.lang && p?.language !== opts.lang) return false;
      if (opts.symbolKind && p?.symbol_type !== opts.symbolKind) return false;
      if (opts.since || opts.until) {
        const cd = p?.effective_date ?? p?.updated_at ?? null;
        const cdMs = cd ? Date.parse(cd) : NaN;
        if (Number.isNaN(cdMs)) return false;
        if (!Number.isNaN(sinceMs) && cdMs < sinceMs) return false;
        if (!Number.isNaN(untilMs) && cdMs > untilMs) return false;
      }
      return true;
    });
  }

  // 5c. Cosine re-score blend (opt-in, default OFF) — re-score each candidate as
  //     0.7*normalizedRRF + 0.3*(query·chunk cosine) BEFORE the multiplicative
  //     boosts + dedup, so a semantically-closer chunk survives the per-doc
  //     collapse. Runs only when the vector arm produced a query vector (nothing
  //     to blend on the keyword-only fallback). Fail-open: a fetch error leaves
  //     the RRF scores intact.
  const cosineRescoreOn =
    opts.cosineRescore ?? process.env.MEMEX_COSINE_RESCORE === "1";
  if (cosineRescoreOn && queryVector !== null) {
    await cosineReScore(scored, engine, queryVector, opts.sourceIds);
  }

  // 6-. Hard-exclude — drop fixtures / attachments / raw sidecars by slug
  //     prefix (default none; MEMEX_SEARCH_EXCLUDE opts in). Cheap precision
  //     filter, applied before scoring so excluded hits never compete.
  const excludePrefixes = getSearchExcludePrefixes();
  if (excludePrefixes.length > 0) {
    scored = scored.filter((s) => !isExcludedPath(s.payload?.sourcePath ?? null, excludePrefixes));
  }

  // 6. Source-boost.
  scored = applySourceBoost(scored);

  // 6b. Recency (documents.updated_at) + salience (frontmatter pinned/weight)
  //     — gentle post-fusion multipliers on the LIVE model. Immutable like
  //     the rest of the pipeline; both are neutral (1.0) when their signal
  //     is absent, so neither can bury a hit that doesn't declare it.
  const nowMs = Date.now();
  // Canonical/definitional queries ("who is X", "define X", a bare symbol)
  // want the authoritative page regardless of age — skip the recency + salience
  // multipliers for them (an explicit temporal bound re-enables freshness).
  const canonical = isCanonicalQuery(trimmed);
  // Curation authority by slug prefix — curated originals outrank bulk feeds
  // inside one store. Orthogonal to recency decay; neutral (×1) off-prefix.
  const curationMap = getCurationBoostMap();
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
      (canonical
        ? 1
        : recencyMultiplierForPath(
            s.payload?.updated_at ?? null,
            nowMs,
            s.payload?.sourcePath ?? null,
            recencyMap,
          )) *
      (canonical ? 1 : salienceMultiplier(s.payload?.frontmatter)) *
      curationMultiplierForPath(s.payload?.sourcePath ?? null, curationMap) *
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
    // Relative score floor (MEMEX_GRAPH_SIGNALS_FLOOR): a hit must score within
    // `ratio` of the top hit to be eligible for a graph signal. Unset → the
    // ratio is undefined → computeFloorThreshold returns -Infinity; collapse
    // that back to `undefined` so the disabled path is byte-identical to the
    // pre-floor call (the `floor === undefined` short-circuit), with no NaN-edge
    // divergence between the two.
    const floor = computeFloorThreshold(scored, graphFloorRatio);
    await applyGraphSignals(scored, engine, {
      enabled: true,
      floorThreshold: Number.isFinite(floor) ? floor : undefined,
      ...(opts.sourceIds ? { sourceIds: opts.sourceIds } : {}),
    });
  }

  // 6d. Backlink-count boost (default ON) — a standing hub signal: multiply each
  //     hit by 1 + 0.05*ln(1+inbound_link_count) using the page's GLOBAL
  //     in-degree from the `links` table. Distinct from graph-signals (which
  //     counts only in-set links, opt-in): this reads whole-corpus in-degree so
  //     a hub earns a small boost on every query. Floor-ratio-gated by the SAME
  //     MEMEX_GRAPH_SIGNALS_FLOOR ratio (undefined → no gate, every hit
  //     eligible). Pre-dedup so the boost decides which chunk survives per-doc
  //     collapse; fail-open on a links query error.
  const backlinkBoostOn =
    opts.backlinkBoost ?? process.env.MEMEX_BACKLINK_BOOST !== "0";
  if (backlinkBoostOn) {
    const floor = computeFloorThreshold(scored, graphFloorRatio);
    await applyBacklinkBoost(scored, engine, {
      floorThreshold: Number.isFinite(floor) ? floor : undefined,
      ...(opts.sourceIds ? { sourceIds: opts.sourceIds } : {}),
    });
  }

  // Re-sort after boost + recency (RRF was already sorted but these flip).
  scored.sort((a, b) => b.score - a.score);

  // 7. Per-document dedup (one chunk per document) — skip for `exact` intent
  //    ("show me everything about this note").
  // Structural walks deliberately surface multiple neighbor chunks from the
  // same document/class (sibling methods, the call-site + its callee), so the
  // one-chunk-per-doc collapse is widened proportionally to the walk depth.
  const maxPerDoc = structural
    ? Math.min(10, Math.max((opts.walkDepth ?? 0) * 5, 5))
    : 1;
  const perDoc =
    intent === "exact"
      ? scored
      : dedupByDocument(scored, { enabled: true, maxPerDoc });

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

  // 8c. Alias-hop (default ON, exact-full-query-alias gated): if the whole
  //     query is a declared alias, boost the canonical page when present or
  //     inject it at the head when absent. Runs on the FULL post-rerank list
  //     (before the trim) so an injected page can't be trimmed out. A normal
  //     (non-alias) query is a no-op.
  let organic: SearchHit[] = final.map((h) => ({
    chunkId: h.chunkId,
    documentId: h.documentId,
    sourcePath: h.payload?.sourcePath ?? "",
    title: h.payload?.title ?? null,
    content: h.payload?.content ?? "",
    score: h.score,
    intent,
  }));
  if (aliasHopEnabled()) {
    organic = await applyAliasHop(organic, storage, trimmed, intent, opts.sourceIds);
  }

  // 8d. Graph-aware Sonnet rerank (opt-in, default OFF) — reorder the top hits
  //     with one paid Sonnet call using a link-graph connectivity hint. Runs on
  //     the FULL post-alias list (before the trim) so a promoted hit can't be
  //     trimmed out. Self-gates (returns input unchanged unless the flag/seam is
  //     set); fail-open on any error or budget skip. Distinct from the Haiku
  //     two-pass rerank above.
  if (opts.graphRerank ?? process.env.MEMEX_GRAPH_RERANK === "1") {
    organic = await graphRerank(trimmed, organic, {
      storage,
      ...(opts.sourceIds ? { sourceIds: [...opts.sourceIds] } : {}),
    });
  }

  // 9. Trim to k (the ranked result, pre-token-budget).
  const ranked: SearchHit[] = organic.slice(0, k);

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

  // 9·content_flag — stamp the WARN marker on any flagged page (best-effort,
  //     post-fusion). Pure-additive; never reorders or breaks search.
  await stampContentFlags(engine, ranked);

  // 9a. Populate the query cache (fire-and-forget) with the ranked chunk
  //     ids at the clock value read on entry. A clock that advanced mid-
  //     search makes this write immediately stale (never read) — harmless.
  //     Skip the write when the embed deadline dropped the vector arm
  //     (`queryVector === null`): that result is keyword-only/degraded, and the
  //     cache key has no vector-availability component, so caching it would pin
  //     the degraded ranking for the whole cache window even after Bedrock
  //     recovers. Recompute next time instead.
  if (cacheReady && queryVector !== null) {
    // Semantic arm (migration 065, opt-in): stamp the bucket key + query
    // embedding so a later paraphrase can match this row by cosine. Only when
    // the arm is on — the default path writes no extra vector per search.
    const semCfg = resolveSemanticCacheConfig();
    const semantic = semCfg.enabled
      ? {
          bucketKey: queryCacheBucketKey(k, opts.sourceIds, rerankWanted),
          queryEmbedding: queryVector,
        }
      : undefined;
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
      semantic,
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
