/**
 * Hybrid search orchestrator — coordinates the pieces in core/search/*.
 *
 * Pipeline:
 *   1. classify intent (zero-LLM regex taxonomy; Haiku only via MEMEX_INTENT_LLM=1)
 *   2. (parallel) embed query → vector retrieval; keyword retrieval
 *      (both arms carry the curation prefix boost + default hard-excludes)
 *   3. (opt-in) query expansion → extra keyword passes
 *   4. RRF fuse all retrieval lists (per-list k/weight)
 *   5. hydrate top-(k * 3) chunks with parent doc + source kind
 *   6. boosts: compiled-truth ×2, source, recency (decay + temporal boost),
 *      salience (+ mattering join), curation, title, graph/backlink,
 *      exact-match, alias-resolved
 *   7. dedup per documentId (cap 2; skipped for `exact` intent) + type diversity
 *   8. (opt-in) two-pass Haiku rerank over the return window if MEMEX_RERANK=1
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
  enforceTypeDiversity,
  type ChunkScore,
} from "./dedup.ts";
import {
  applySourceBoost,
  type BoostablePayload,
} from "./source-boost.ts";
import { classifyIntent, type Intent } from "./intent.ts";
import {
  rrfWeightsForLists,
  exactMatchBoostForTaxonomy,
  exactMatchIndices,
} from "./intent-weights.ts";
import { classifyQuerySuggestions } from "./query-intent.ts";
import { activeModeBundle, resolveKnob, resolveSearchMode } from "./mode.ts";
import { recordSearchTelemetry } from "./telemetry.ts";
import {
  recencyMultiplierForPath,
  resolveRecencyDecayMap,
  resolveRecencyBoostMap,
  recencyBoostMultiplierForPath,
} from "./recency.ts";
import { salienceMultiplier, applyMatteringBoost } from "./salience.ts";
import { applyAliasResolvedBoost, ALIAS_RESOLVED_BOOST } from "./alias-resolved.ts";
import { slugCandidatesForPath } from "./page-slug.ts";
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
  rankingSignature,
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
import { relationalArmChunkIds } from "./relational-recall.ts";
import {
  snapshotScores,
  recordStageFactor,
  mergeExplain,
  finalizeExplain,
  type SearchExplain,
} from "./explain.ts";

/**
 * RRF weight for the deterministic relational arm (opt-in 4th arm). A gentle
 * multiplier on par with the keyword arm — a typed-edge answer should compete,
 * not dominate. Env-overridable (MEMEX_RELATIONAL_ARM_WEIGHT); an invalid value
 * falls back to the default.
 */
function relationalArmWeight(): number {
  const n = Number(process.env.MEMEX_RELATIONAL_ARM_WEIGHT);
  return Number.isFinite(n) && n > 0 ? n : 1.0;
}

// Recency decay map resolved once per process (defaults ∪ MEMEX_RECENCY_DECAY).
// Memoized so the env parse + its fail-loud validation runs on the first
// search, not on every query.
let _recencyDecayMap: ReturnType<typeof resolveRecencyDecayMap> | null = null;
function getRecencyDecayMap(): ReturnType<typeof resolveRecencyDecayMap> {
  return (_recencyDecayMap ??= resolveRecencyDecayMap());
}

// Recency BOOST map (defaults ∪ MEMEX_RECENCY_BOOST) — same memoization
// contract as the decay map. Only consulted when the zero-LLM classifier
// suggests a temporal tilt (recency 'on'/'strong').
let _recencyBoostMap: ReturnType<typeof resolveRecencyBoostMap> | null = null;
function getRecencyBoostMap(): ReturnType<typeof resolveRecencyBoostMap> {
  return (_recencyBoostMap ??= resolveRecencyBoostMap());
}

/**
 * Compiled-truth boost (reference parity): chunks of a page's compiled-truth
 * mirror (`page-truth://…`, see page-index.ts) are the canonical per-page
 * answers, multiplied ×2 after fusion. The reference applies this right after
 * RRF max-normalization; memex applies it on the raw fused score — a uniform
 * multiplier is scale-invariant, so the resulting ORDER is identical.
 * Bypassed for temporal queries (suggestedDetail 'high'), matching the
 * reference's detail=high gate — freshness queries want the record, not the
 * distilled truth.
 */
const COMPILED_TRUTH_BOOST = 2.0;
const PAGE_TRUTH_PREFIX = "page-truth://";

/** The resolved per-call ranking knob set (see {@link resolveSearchKnobs}). */
export interface ResolvedSearchKnobs {
  rerankWanted: boolean;
  expansionEnabled: boolean;
  graphSignalsOn: boolean;
  cosineRescoreOn: boolean;
  relationalArmOn: boolean;
  backlinkBoostOn: boolean;
  tokenBudget: number | undefined;
}

/**
 * Resolve the ranking knobs for one search call — per-call opts win, then an
 * explicit per-knob env ("1"/"0"), then the active mode bundle
 * (MEMEX_SEARCH_MODE; the default `conservative` bundle equals memex's
 * historical all-OFF defaults). Exported so tests and cache-key callers can
 * reproduce exactly what hybridSearch resolves.
 *
 * Expansion default OFF (the reference measured negligible lift; each call is
 * a paid Haiku request). The hermetic `expandQueryFn` seam implies ON — a test
 * that injects an expander wants the expansion path exercised. `noExpansion`
 * is the hard veto either way.
 */
export function resolveSearchKnobs(opts: SearchOptions = {}): ResolvedSearchKnobs {
  const bundle = activeModeBundle();
  const env = process.env;
  return {
    rerankWanted: resolveKnob(opts.rerank, env.MEMEX_RERANK, bundle.rerank),
    expansionEnabled:
      !opts.noExpansion &&
      (opts.expansion ??
        (opts.expandQueryFn !== undefined ||
          resolveKnob(undefined, env.MEMEX_QUERY_EXPANSION, bundle.expansion))),
    graphSignalsOn: resolveKnob(opts.graphSignals, env.MEMEX_GRAPH_SIGNALS, bundle.graphSignals),
    cosineRescoreOn: resolveKnob(opts.cosineRescore, env.MEMEX_COSINE_RESCORE, bundle.cosineRescore),
    relationalArmOn: resolveKnob(opts.relationalArm, env.MEMEX_RELATIONAL_ARM, bundle.relationalArm),
    // Backlink boost keeps its default-ON contract in every mode.
    backlinkBoostOn: opts.backlinkBoost ?? env.MEMEX_BACKLINK_BOOST !== "0",
    tokenBudget: opts.tokenBudget ?? bundle.tokenBudget,
  };
}

/**
 * The per-call resolved-knob suffix appended to the env-level
 * rankingSignature() for the query-cache key — a caller flipping a knob per
 * call must never share a cached ordering with one that didn't.
 */
export function knobsCacheSuffix(kn: ResolvedSearchKnobs): string {
  return (
    `:RXP=${kn.expansionEnabled ? 1 : 0}:RGS=${kn.graphSignalsOn ? 1 : 0}` +
    `:RCR=${kn.cosineRescoreOn ? 1 : 0}:RBB=${kn.backlinkBoostOn ? 1 : 0}`
  );
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
  /** Override the zero-LLM intent classification — for tests / callers that know. */
  intent?: Intent;
  /** Skip query expansion. */
  noExpansion?: boolean;
  /**
   * Force LLM query expansion on/off for this call. Default OFF (reference
   * parity — the measured lift is negligible and each expansion is a paid
   * Haiku call): resolution is `expansion` → MEMEX_QUERY_EXPANSION ("1"/"0")
   * → the active mode bundle (only `tokenmax` turns it on). Passing
   * `expandQueryFn` (the hermetic test seam) implies ON unless `noExpansion`.
   */
  expansion?: boolean;
  /**
   * Optional query-expander injection. Defaults to the real Bedrock expander;
   * set ONLY by hermetic tests to drive the expansion pass with deterministic
   * synonyms (no Bedrock). Production never passes this.
   */
  expandQueryFn?: (query: string, opts: { max: number }) => Promise<string[]>;
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
  /**
   * Relational recall as a 4th RRF arm (opt-in, default OFF): parse the query
   * for a typed-edge intent ("who founded X", "where does Y work") and fuse the
   * deterministic edge fan-out's page head-chunks alongside keyword + vector, so
   * a relationship answer competes for ranking instead of relying on lexical /
   * vector overlap to surface it. Falls back to MEMEX_RELATIONAL_ARM=1. Bypasses
   * the query cache (the arm widens the candidate set). No-op for non-relational
   * queries. See relational-recall.ts.
   */
  relationalArm?: boolean;
  /**
   * Per-page max-pool (opt-in, default OFF): make each retrieval arm return its
   * best chunk per (source, document) so the fanout budget covers N distinct
   * pages, not N chunks that collapse to fewer pages downstream. Falls back to
   * MEMEX_MAXPOOL=1. Auto-disabled for `exact` intent and structural walks
   * (both deliberately want multiple chunks per page). See keyword/vector.ts.
   */
  maxPool?: boolean;
  /**
   * Per-signal ranking attribution (opt-in, default OFF): stamp each returned
   * hit with a `explain` record — the base RRF score plus the factor every boost
   * stage contributed (source/recency/salience/curation/title/backlink/graph)
   * and the reranker's rank delta. Zero cost when off. See explain.ts.
   */
  explain?: boolean;
  /**
   * Per-call detail override (reference `query` op parity). Overrides the
   * zero-LLM classifier's suggestion: `high` gets the temporal treatment
   * (source-boost bypass) AND lifts the per-document chunk cap (all chunks);
   * `low` collapses to one chunk per document; `medium` keeps the default
   * cap. Bypasses the query cache (it changes the returned set).
   */
  detail?: "low" | "medium" | "high";
  /**
   * Per-call mattering-salience bias (reference `query` op parity): overrides
   * BOTH the classifier suggestion and the canonical-query gate. `strong`
   * uses the aggressive mattering coefficient. Bypasses the query cache.
   */
  salience?: "off" | "on" | "strong";
  /**
   * Per-call recency-boost bias (reference `query` op parity): overrides BOTH
   * the classifier suggestion and the canonical-query gate. Bypasses the
   * query cache.
   */
  recency?: "off" | "on" | "strong";
  /**
   * @internal Set by the zero-result broadened retry to stop recursion after a
   * single re-run. Callers never set this.
   */
  _zeroRetried?: boolean;
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
  /**
   * Per-signal ranking attribution — present ONLY when the search ran with the
   * opt-in `explain` flag. See explain.ts / SearchOptions.explain.
   */
  explain?: SearchExplain;
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

  // Zero-LLM query suggestions (reference parity, query-intent.ts): one regex
  // pass drives the temporal source-boost bypass, the recency-boost strength,
  // the mattering-salience gate, and the exact-match boost magnitude.
  const suggestions = classifyQuerySuggestions(trimmed);
  // Agent-explicit detail wins over the classifier (reference: the query op's
  // explicit detail/salience/recency params override the heuristic).
  const detailResolved = opts.detail ?? suggestions.suggestedDetail;
  const temporalQuery = detailResolved === "high";

  const {
    rerankWanted,
    expansionEnabled,
    graphSignalsOn,
    cosineRescoreOn,
    relationalArmOn,
    backlinkBoostOn,
    tokenBudget,
  } = resolveSearchKnobs(opts);

  // 0. Exact-match query cache (fail-open). A hit skips intent + embed +
  //    retrieval + fusion entirely. Validity is gated on the live-model
  //    generation clock, so any document write invalidates it. Any cache
  //    error falls through to a normal search — the cache is pure
  //    optimization and must never break retrieval.
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
  // Relational recall (resolved above) widens the candidate set beyond what
  // the query alone produces, so its result must never be served from — nor
  // written to — the exact-match query cache.
  // Per-signal explain (opt-in). Its stamping never changes ranking, but a
  // cached hit re-hydrates ids without the per-stage factors, so an explain call
  // bypasses the cache to guarantee the attribution is always populated.
  const explainOn = opts.explain ?? false;
  // Per-page max-pool (opt-in) changes the retrieval ranking but is NOT part of
  // the query-cache key, so a max-pool call must bypass the cache rather than
  // read/write a ranking that a non-pooled call could share. Resolved from the
  // raw flag here (the intent/structural refinement below only ever narrows it).
  const maxPoolRequested = opts.maxPool ?? process.env.MEMEX_MAXPOOL === "1";
  // Per-call ranking overrides (detail / salience / recency) change the
  // returned set or its order but are NOT part of the cache key — bypass the
  // cache rather than share a ranking a default call could re-serve.
  const rankingOverrides = Boolean(opts.detail || opts.salience || opts.recency);
  const cacheEnabled =
    !opts.noCache &&
    !hasFilters &&
    !structural &&
    !relationalArmOn &&
    !explainOn &&
    !maxPoolRequested &&
    !rankingOverrides &&
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
      tokenBudget !== undefined
        ? applyTokenBudget(hydrated, tokenBudget)
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
    // Per-day rollup (migration 089) — sync bucket bump, flushed off the hot
    // path; fail-open by construction.
    recordSearchTelemetry(
      engine,
      { mode: resolveSearchMode(), intent: cachedIntent, cache: "hit" },
      hits,
      hydrated.length - hits.length,
    );
    // Adaptive return-sizing (opt-in, default OFF) — the FINAL view, applied
    // after the cache read served the full stored set and after capture saw it,
    // so the cap never poisons the cache or shrinks the eval window.
    return applyAdaptiveReturn(hits, cachedIntent, adaptiveCfg).kept;
  };
  // Ranking signature for the cache key: the env-level signature plus the
  // per-call RESOLVED knob values (the reference's knobs-hash) — a caller that
  // flips graph-signals/cosine/backlink/expansion per call must never share a
  // cached ordering with a caller that didn't.
  const rankingSig =
    rankingSignature() +
    knobsCacheSuffix({
      rerankWanted,
      expansionEnabled,
      graphSignalsOn,
      cosineRescoreOn,
      relationalArmOn,
      backlinkBoostOn,
      tokenBudget,
    });
  if (cacheEnabled) {
    try {
      cacheClock = await currentDocumentClock(engine);
      cacheKey = queryCacheKey(trimmed, k, opts.sourceIds, rerankWanted, rankingSig);
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
        const bucket = queryCacheBucketKey(k, opts.sourceIds, rerankWanted, rankingSig);
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

  // Per-page max-pool (opt-in) — make each arm return its best chunk per page.
  // Auto-disabled for `exact` intent and structural walks, both of which
  // deliberately want multiple chunks per page (the collapse would fight them).
  const maxPoolOn = maxPoolRequested && intent !== "exact" && !structural;

  // Curation prefix boost inside the arm SQL (reference parity): shapes which
  // rows survive the per-arm LIMIT. Bypassed for temporal queries — freshness
  // queries must not be steered toward evergreen curated tiers.
  const armSourceBoost = !temporalQuery;

  const [vectorIds, primaryKeywordIds] = await Promise.all([
    queryVector
      ? vectorSearch(engine, queryVector, fanout, {
          sourceIds: opts.sourceIds,
          filters: chunkFilters,
          maxPool: maxPoolOn,
          sourceBoost: armSourceBoost,
        })
      : Promise.resolve<string[]>([]),
    keywordSearch(engine, trimmed, fanout, {
      sourceIds: opts.sourceIds,
      filters: chunkFilters,
      maxPool: maxPoolOn,
      sourceBoost: armSourceBoost,
    }),
  ]);

  // 3. Expansion (default OFF — see SearchOptions.expansion; skipped for
  //    exact intent regardless).
  const lists: string[][] = [vectorIds, primaryKeywordIds];
  if (intent !== "exact" && expansionEnabled) {
    const variants = await (opts.expandQueryFn ?? expandQuery)(trimmed, { max: 3 });
    if (variants.length > 0) {
      const extra = await Promise.all(
        variants.map((v) =>
          keywordSearch(engine, v, fanout, {
            sourceIds: opts.sourceIds,
            filters: chunkFilters,
            maxPool: maxPoolOn,
            sourceBoost: armSourceBoost,
          }),
        ),
      );
      lists.push(...extra);
    }
  }

  // 4. RRF fuse — weighted by intent (base list order is [vector, keyword,
  //    ...keywordExpansions], so keyword lists = lists.length - 1). The optional
  //    relational arm is fused as an extra list with its own gentle weight.
  const rrfWeights = rrfWeightsForLists(intent, lists.length - 1);
  // 3b. Relational recall arm (opt-in, default OFF) — a deterministic 4th arm.
  //     Built from the ORIGINAL query (never an expansion variant); empty for
  //     non-relational queries → pure no-op. Fail-open inside the helper.
  if (relationalArmOn) {
    const relationalIds = await relationalArmChunkIds(storage, trimmed, {
      ...(opts.sourceIds ? { sourceIds: [...opts.sourceIds] } : {}),
      limit: fanout,
    });
    if (relationalIds.length > 0) {
      lists.push(relationalIds);
      rrfWeights.push(relationalArmWeight());
    }
  }
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

  if (fused.length === 0) {
    // Zero-result broadened retry (once). The only lever that can turn an empty
    // set non-empty is query expansion (different terms) — a bigger fanout can't
    // add rows that don't exist. So when an `exact`-intent pass found nothing and
    // expansion was permitted (the caller didn't opt out), re-run as `topic`,
    // which re-enables the synonym expansion pass. Gated OFF for filtered /
    // structural queries (an empty filtered set is correct semantics) and when
    // expansion is disabled (default OFF / `noExpansion` — a topic re-run
    // without the synonym pass would fuse the same empty lists), and capped at
    // one retry via `_zeroRetried`.
    const canBroaden =
      !opts._zeroRetried &&
      !hasFilters &&
      !structural &&
      expansionEnabled &&
      intent === "exact";
    if (canBroaden) {
      return await hybridSearch(storage, query, {
        ...opts,
        intent: "topic",
        noCache: true,
        _zeroRetried: true,
      });
    }
    return [];
  }

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

  // Per-signal explain (opt-in) — accumulate each stage's factor keyed by
  // chunkId. The base is the fused RRF (+cosine) score captured here, right
  // before the first multiplicative boost. Only allocated/snapshotted when the
  // flag is on, so a normal search pays nothing.
  const explainAcc = explainOn ? new Map<string, Partial<SearchExplain>>() : null;
  if (explainAcc) for (const s of scored) explainAcc.set(s.chunkId, { base: s.score });

  // 5d. Compiled-truth boost — a page's canonical answers (its compiled-truth
  //     mirror chunks) get ×2 so the distilled truth outranks body prose for
  //     the same page. Skipped for temporal queries (reference detail=high
  //     gate). Pre-dedup like every other boost, so the truth chunk wins the
  //     per-doc collapse of its own mirror document.
  if (!temporalQuery) {
    for (const s of scored) {
      if (s.payload?.sourcePath?.startsWith(PAGE_TRUTH_PREFIX)) {
        s.score *= COMPILED_TRUTH_BOOST;
        if (explainAcc) {
          mergeExplain(explainAcc, s.chunkId, { compiled_truth: COMPILED_TRUTH_BOOST });
        }
      }
    }
  }

  // 6. Source-boost.
  const preSourceBoost = explainAcc ? snapshotScores(scored) : null;
  scored = applySourceBoost(scored);
  if (explainAcc && preSourceBoost) {
    recordStageFactor(explainAcc, preSourceBoost, scored, "source");
  }

  // 6b. Recency (documents.effective_date) + salience (frontmatter pinned/weight)
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
  // Recency BOOST activation (reference parity): the zero-LLM classifier's
  // off/on/strong suggestion. 'off' keeps the historical penalty-only decay;
  // 'on'/'strong' additionally LIFT fresh content hyperbolically so a
  // this-week note can win a "what's going on" query. Canonical queries stay
  // fully recency-neutral (both decay and boost skipped).
  // An explicit per-call recency bias overrides both the classifier and the
  // canonical gate (the agent asserted the temporal intent).
  const recencyBoostMode =
    opts.recency ?? (canonical ? "off" : suggestions.suggestedRecency);
  const recencyBoostMap = recencyBoostMode === "off" ? null : getRecencyBoostMap();
  scored = scored.map((s) => {
    const contentDate = s.payload?.effective_date ?? s.payload?.updated_at ?? null;
    const decayF = canonical
      ? 1
      : recencyMultiplierForPath(
          // Decay on the content date (effective_date, already COALESCE'd with
          // updated_at at hydrate), NOT the row's updated_at — a backfill /
          // re-ingest / rechunk bumps updated_at and would otherwise make stale
          // content score as fresh.
          contentDate,
          nowMs,
          s.payload?.sourcePath ?? null,
          recencyMap,
        );
    const boostF = recencyBoostMap
      ? recencyBoostMultiplierForPath(
          contentDate,
          nowMs,
          s.payload?.sourcePath ?? null,
          recencyBoostMode as "on" | "strong",
          recencyBoostMap,
        )
      : 1;
    const recencyF = decayF * boostF;
    const salienceF = canonical ? 1 : salienceMultiplier(s.payload?.frontmatter);
    const curationF = curationMultiplierForPath(s.payload?.sourcePath ?? null, curationMap);
    const titleF =
      titleBoostActive && isTitlePhraseMatch(trimmed, s.payload?.title) ? titleBoost : 1;
    if (explainAcc) {
      const patch: Partial<SearchExplain> = {};
      if (recencyF !== 1) patch.recency = recencyF;
      if (salienceF !== 1) patch.salience = salienceF;
      if (curationF !== 1) patch.curation = curationF;
      if (titleF !== 1) patch.title = titleF;
      mergeExplain(explainAcc, s.chunkId, patch);
    }
    return { ...s, score: s.score * recencyF * salienceF * curationF * titleF };
  });

  // 6b2. Mattering-salience join (reference parity) — the cycle-computed
  //      pages.salience score (emotional-weight tags + link degree + takes)
  //      lifts "what matters" pages when the query asks for current context
  //      (meeting prep / catch-up phrasings). Classifier-gated; canonical
  //      queries never fire it. Fail-open; floor-gated like the other
  //      metadata boosts.
  // Explicit per-call salience bias wins over classifier + canonical gate;
  // 'strong' selects the aggressive mattering coefficient.
  const matteringOn =
    opts.salience !== undefined
      ? opts.salience !== "off"
      : !canonical && suggestions.suggestedSalience === "on";
  if (matteringOn) {
    const floor = computeFloorThreshold(scored, graphFloorRatio);
    const preMattering = explainAcc ? snapshotScores(scored) : null;
    try {
      await applyMatteringBoost(scored, engine, {
        strength: opts.salience === "strong" ? "strong" : "on",
        ...(Number.isFinite(floor) ? { floorThreshold: floor } : {}),
      });
    } catch {
      // A pages lookup error leaves scores intact.
    }
    if (explainAcc && preMattering) {
      recordStageFactor(explainAcc, preMattering, scored, "mattering");
    }
  }

  // 6c. Graph signals (opt-in, default OFF) — adjacency hub boost + session
  //     diversification over the link graph, applied pre-dedup on the full
  //     scored set so a hub's chunk can rise before per-doc collapse. Mutates
  //     score in place; fail-open (a links query error leaves scores intact).
  if (graphSignalsOn) {
    // Relative score floor (MEMEX_GRAPH_SIGNALS_FLOOR): a hit must score within
    // `ratio` of the top hit to be eligible for a graph signal. Unset → the
    // ratio is undefined → computeFloorThreshold returns -Infinity; collapse
    // that back to `undefined` so the disabled path is byte-identical to the
    // pre-floor call (the `floor === undefined` short-circuit), with no NaN-edge
    // divergence between the two.
    const floor = computeFloorThreshold(scored, graphFloorRatio);
    const preGraph = explainAcc ? snapshotScores(scored) : null;
    await applyGraphSignals(scored, engine, {
      enabled: true,
      floorThreshold: Number.isFinite(floor) ? floor : undefined,
      ...(opts.sourceIds ? { sourceIds: opts.sourceIds } : {}),
    });
    if (explainAcc && preGraph) recordStageFactor(explainAcc, preGraph, scored, "graph");
  }

  // 6d. Backlink-count boost (default ON) — a standing hub signal: multiply each
  //     hit by 1 + 0.05*ln(1+inbound_link_count) using the page's GLOBAL
  //     in-degree from the `links` table. Distinct from graph-signals (which
  //     counts only in-set links, opt-in): this reads whole-corpus in-degree so
  //     a hub earns a small boost on every query. Floor-ratio-gated by the SAME
  //     MEMEX_GRAPH_SIGNALS_FLOOR ratio (undefined → no gate, every hit
  //     eligible). Pre-dedup so the boost decides which chunk survives per-doc
  //     collapse; fail-open on a links query error.
  if (backlinkBoostOn) {
    const floor = computeFloorThreshold(scored, graphFloorRatio);
    const preBacklink = explainAcc ? snapshotScores(scored) : null;
    await applyBacklinkBoost(scored, engine, {
      floorThreshold: Number.isFinite(floor) ? floor : undefined,
      ...(opts.sourceIds ? { sourceIds: opts.sourceIds } : {}),
    });
    if (explainAcc && preBacklink) recordStageFactor(explainAcc, preBacklink, scored, "backlink");
  }

  // 6e. Exact-match boost (reference parity) — a hit whose slug / kebab-slug /
  //     title IS the query wins the tie on entity/event queries (the user
  //     typed the thing's name). Lexical-relevance signal: NOT floor-gated,
  //     mirroring the reference's placement outside the metadata gate.
  const exactBoost = exactMatchBoostForTaxonomy(suggestions.taxonomy);
  if (exactBoost > 1.0) {
    const cands = scored.map((s) => ({
      slugs: slugCandidatesForPath(s.payload?.sourcePath ?? null, s.payload?.source_id ?? null),
      title: s.payload?.title ?? null,
    }));
    for (const i of exactMatchIndices(cands, trimmed)) {
      const s = scored[i]!;
      s.score *= exactBoost;
      if (explainAcc) mergeExplain(explainAcc, s.chunkId, { exact: exactBoost });
    }
  }

  // 6f. Alias-resolved canonical boost (reference parity, ×1.05) — pages that
  //     old slugs forward to (slug_aliases canonical side) are the explicitly
  //     disambiguated authority. Fail-open: a pre-migration store no-ops.
  try {
    const touched = await applyAliasResolvedBoost(scored, engine);
    if (explainAcc) {
      for (const i of touched) {
        mergeExplain(explainAcc, scored[i]!.chunkId, { alias: ALIAS_RESOLVED_BOOST });
      }
    }
  } catch {
    // Non-fatal — the boost is a nudge, never a dependency.
  }

  // Re-sort after boost + recency (RRF was already sorted but these flip).
  scored.sort((a, b) => b.score - a.score);

  // 7. Per-document dedup — cap 2 chunks per document (reference parity:
  //    maxPerPage 2; one strong page may show its two best chunks, the rest
  //    yield slots to other pages). Skip for `exact` intent ("show me
  //    everything about this note").
  // Structural walks deliberately surface multiple neighbor chunks from the
  // same document/class (sibling methods, the call-site + its callee), so the
  // one-chunk-per-doc collapse is widened proportionally to the walk depth.
  const maxPerDoc = structural
    ? Math.min(10, Math.max((opts.walkDepth ?? 0) * 5, 5))
    : opts.detail === "low"
      ? 1
      : 2;
  // detail 'high' = the reference's all-chunks view: skip the per-doc collapse
  // entirely (like `exact` intent), so every matching chunk of a page returns.
  const perDoc =
    intent === "exact" || opts.detail === "high"
      ? scored
      : dedupByDocument(scored, { enabled: true, maxPerDoc });

  // 7b. Type-diversity layer (reference parity): no page type may exceed
  //     MEMEX_MAX_TYPE_RATIO (default 0.6) of the candidate set, so one noisy
  //     shape (chat exports, dailies) can't monopolise every slot. Skipped for
  //     `exact` intent and structural walks (both deliberately homogeneous).
  const diversified =
    intent === "exact" || structural || opts.detail === "high"
      ? perDoc
      : enforceTypeDiversity(perDoc);

  // 8. Two-pass rerank (opt-in) — runs BEFORE near-dup so the reranker sees
  //    both near-identical twins and decides their order; near-dup then drops
  //    the now-lower-ranked one (the reranker can't undo a drop, so it must
  //    come first). Reference contract: the head sent upstream is exactly the
  //    return window (k), so every returned hit carries a rerank decision, and
  //    the un-reranked tail keeps its fused order behind the head instead of
  //    being truncated away (it still feeds near-dup / alias-hop recall).
  const preRerankOrder =
    explainAcc && rerankWanted
      ? new Map(diversified.map((h, i) => [h.chunkId, i] as const))
      : null;
  const reranked = rerankWanted
    ? [...(await rerank(trimmed, diversified.slice(0, k))), ...diversified.slice(k)]
    : diversified;
  if (explainAcc && preRerankOrder) {
    reranked.forEach((h, i) => {
      const prev = preRerankOrder.get(h.chunkId);
      if (prev !== undefined && prev !== i) {
        mergeExplain(explainAcc, h.chunkId, { rerank_delta: prev - i });
      }
    });
  }

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

  // 9·explain — stamp per-signal attribution on the FINAL ranked hits (opt-in).
  //     Uses each hit's returned score as `final`; a hit with no accumulated
  //     factors (e.g. an alias-injected page that skipped the boost stages)
  //     finalizes to base=final with no boost lines. Pure-additive; no reorder.
  if (explainAcc) {
    for (let i = 0; i < ranked.length; i++) {
      const h = ranked[i]!;
      ranked[i] = { ...h, explain: finalizeExplain(explainAcc.get(h.chunkId), h.score) };
    }
  }

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
          bucketKey: queryCacheBucketKey(k, opts.sourceIds, rerankWanted, rankingSig),
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

  // 9b. Token budget (opt-in / mode-resolved) — cap total returned context size.
  let hits: SearchHit[] = ranked;
  if (tokenBudget !== undefined) {
    hits = applyTokenBudget(hits, tokenBudget);
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
        expansion: intent !== "exact" && expansionEnabled,
      });
    } catch {
      // Capture failures must not surface; classifier in eval-capture
      // already categorises them for the caller's logging.
    }
  }

  // 10b. Per-day telemetry rollup (migration 089) — sync bucket bump, flushed
  //      off the hot path; "miss" only when the cache was in play this call.
  recordSearchTelemetry(
    engine,
    { mode: resolveSearchMode(), intent, cache: cacheEnabled ? "miss" : "off" },
    hits,
    ranked.length - hits.length,
  );

  // 11. Adaptive return-sizing (opt-in, default OFF) — the FINAL step. Applied
  //     after the cache write (9a stored the full `ranked` set) AND after the
  //     eval-capture hook (which records the full returned candidate set), so
  //     the cap is a pure view on the returned value: it never poisons the
  //     cache and never shrinks the eval window. Default OFF → `hits` unchanged.
  return applyAdaptiveReturn(hits, intent, adaptiveCfg).kept;
}
