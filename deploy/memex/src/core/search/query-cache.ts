/**
 * Exact-match query cache (migration 026) with two-layer invalidation
 * (migration 031).
 *
 * A cache hit returns a previously-computed ranking for an identical query,
 * letting the caller skip embedding + intent classification + retrieval +
 * fusion entirely. Validity is gated by two layers:
 *
 *   Layer 1 (cheap bookmark): the live-model `document_generation_clock`.
 *     A row whose stored `clock_value` equals the current clock is fresh
 *     corpus-wide — nothing has written since it stored (migration 025). The
 *     clock is monotonic, so `clock_value = current` IS the bookmark.
 *
 *   Layer 2 (per-document snapshot, migration 031): when the bookmark fails
 *     (some write happened), fall through to the `doc_generations` snapshot —
 *     `{document_id: generation}` for every document the cached result chunks
 *     belong to. The row still serves iff every recorded document still EXISTS
 *     and its `documents.generation` is unchanged. So a write to an UNRELATED
 *     document no longer evicts this query (the old global-clock gate did).
 *
 * Empty snapshot (`{}`) does NOT pass Layer 2: an empty map has no per-doc
 * signal to disprove staleness, so it relies on Layer 1 exclusively. This
 * covers empty-result queries and pre-migration-031 rows (which default to
 * `{}`) — they invalidate on the first post-write lookup, then refill.
 *
 * Accepted tradeoff (faithful to the reference design): the snapshot records
 * only the documents in the cached RESULT set. Any document NOT in that set —
 * whether brand-new or an existing one edited into relevance for this query —
 * does NOT invalidate the row, so it can serve a result that omits a now-
 * relevant document until one of its referenced docs changes or it is pruned.
 * Higher hit rate, bounded staleness — acceptable for a low-write personal
 * brain. Writers that need a hard corpus-wide flush (e.g. embedding backfill,
 * which re-embeds many docs WITHOUT bumping their generation) call
 * `clearCache()` explicitly. Every writer that changes a ranking-relevant field
 * of a document (content, frontmatter/salience, source assignment) bumps that
 * document's `generation` AND the global clock, so a cached row that DID return
 * the changed document is correctly invalidated.
 *
 * The cache stores ordered chunk ids, NOT content — on a hit the caller
 * re-hydrates from the live tables, so returned text is always current.
 *
 * Every function is safe to wrap in try/catch by the caller: the cache is a
 * pure optimization and a failure must fall through to a normal search.
 */
import { createHash } from "node:crypto";
import type { Engine } from "../engine/interface.ts";
import { getTitleBoost } from "./title-match.ts";
import { getNearDupThreshold } from "./dedup.ts";
import { getGraphSignalsFloorRatio } from "./graph-signals.ts";

export interface CachedQuery {
  intent: string | null;
  resultIds: string[];
}

/**
 * Post-fusion ranking version. Bump this string whenever the ORDER a search
 * returns changes for reasons NOT already captured by the cache key (query, k,
 * scope, rerank) — e.g. a new post-fusion boost. It is folded into the key so a
 * deploy that changes ranking invalidates stale cached orderings immediately,
 * instead of serving a pre-change order until the document clock happens to
 * advance. `2` = the title-phrase boost (v1.3.20); `3` = the near-dup dedup
 * stage (v1.3.25); `4` = the graph-signals score-floor ratio
 * (MEMEX_GRAPH_SIGNALS_FLOOR), which changes which hits receive graph boosts.
 */
const RANKING_VERSION = "4";

/**
 * Signature of the ranking inputs that are NOT function arguments, so a change
 * to any of them re-keys the cache instead of serving a pre-change ordering:
 *   - `RANKING_VERSION` — code-level ranking changes (bump on a new boost);
 *   - the live title-boost factor (`MEMEX_TITLE_BOOST`), read through the SAME
 *     memoized getter the ranking uses, so the key and the order never diverge;
 *   - the raw `MEMEX_RECENCY_DECAY` env, which also reorders results;
 *   - the near-dup Jaccard threshold (`MEMEX_NEARDUP_JACCARD`), which changes
 *     which hits survive dedup;
 *   - the graph-signals score-floor ratio (`MEMEX_GRAPH_SIGNALS_FLOOR`), which
 *     changes which hits are eligible for a graph boost.
 * NOTE: time-based recency (a hit ages between writes) still drifts the true
 * order within a cache lifetime — that is inherent to caching a wall-clock
 * ranking and is accepted by design (the cache is gated on the document
 * generation clock, so any document write refreshes it).
 */
export function rankingSignature(): string {
  const recency = process.env["MEMEX_RECENCY_DECAY"] ?? "";
  return `${RANKING_VERSION}:tb=${getTitleBoost()}:rd=${recency}:nd=${getNearDupThreshold()}:gsf=${getGraphSignalsFloorRatio()}`;
}

/**
 * The two-layer freshness predicate as a SQL boolean, parameterised on the
 * placeholder that carries the current clock value. Shared by `getCachedQuery`
 * (serve iff fresh), `pruneCache` (delete iff NOT fresh) and `cacheStats`
 * (count fresh/stale) so all three agree on what "servable" means — a single
 * source of truth for the gate.
 *
 * Requires the `query_cache` row aliased as `qc`. Layer 1 is the cheap
 * single-row clock equality; Layer 2 is the per-document snapshot check
 * (non-empty snapshot AND no referenced document deleted or generation-bumped).
 */
export function cacheFreshClause(clockParam: string): string {
  // Defence-in-depth: the only callers pass a module-internal positional
  // placeholder ("$1"/"$2"), never user data. Assert the shape so a future
  // refactor can't turn this string-builder into an injection vector.
  if (!/^\$\d+$/.test(clockParam)) {
    throw new Error(
      `cacheFreshClause: clockParam must be a positional placeholder like "$1", got ${JSON.stringify(clockParam)}`,
    );
  }
  return `(
    qc.clock_value = ${clockParam}
    OR (
      qc.doc_generations <> '{}'::jsonb
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_each_text(qc.doc_generations) AS g(doc_id, stored_gen)
        LEFT JOIN documents d ON d.id = g.doc_id
        -- Compare as TEXT, not via (stored_gen)::bigint: a malformed snapshot
        -- value (only reachable by manual DB tampering — writes go through
        -- jsonb_object_agg of a BIGINT) would otherwise abort the read/prune/
        -- stats query. As text, garbage simply fails to match → invalidate.
        WHERE d.id IS NULL                         -- document deleted → invalidate
           OR d.generation::text <> g.stored_gen   -- document bumped  → invalidate
      )
    )
  )`;
}

/**
 * Pure mirror of {@link cacheFreshClause} for unit testing the two-layer gate
 * without a database. Given a cache row's stored snapshot and the current brain
 * state, return whether the row would still serve.
 *
 * `current.docGenerations[id] === undefined` means the document no longer
 * exists (deleted). An empty stored snapshot returns false unless Layer 1
 * already matched — empty maps cannot disprove staleness (CDX-6 parity).
 */
export function validateCacheRow(
  stored: { clockValue: number; docGenerations: Record<string, number> },
  current: { clock: number; docGenerations: Record<string, number | undefined> },
): boolean {
  if (stored.clockValue === current.clock) return true; // Layer 1: bookmark.
  const ids = Object.keys(stored.docGenerations);
  if (ids.length === 0) return false; // Empty snapshot → Layer 1 only.
  for (const id of ids) {
    const cur = current.docGenerations[id];
    if (cur === undefined) return false; // Document deleted.
    if (cur !== stored.docGenerations[id]) return false; // Document bumped.
  }
  return true; // Layer 2: every referenced document unchanged.
}

/**
 * Deterministic cache key. Includes everything that changes the ranking
 * output: normalized query text, k, the (order-independent) source scope,
 * whether reranking is on, and the ranking signature (version + live boost
 * factor). Intent + expansion are derived from the query and therefore already
 * implied by it.
 */
export function queryCacheKey(
  query: string,
  k: number,
  sourceIds: readonly string[] | undefined,
  rerank: boolean,
  rankingSig: string = rankingSignature(),
): string {
  const scope = sourceIds && sourceIds.length > 0
    ? [...sourceIds].map((s) => s.toLowerCase()).sort()
    : [];
  const material = JSON.stringify([
    query.trim().toLowerCase().replace(/\s+/g, " "),
    k,
    scope,
    rerank ? 1 : 0,
    rankingSig,
  ]);
  return createHash("sha256").update(material).digest("hex");
}

/**
 * Return the cached ranking iff it exists AND passes the two-layer freshness
 * gate (Layer 1 clock bookmark OR Layer 2 per-document snapshot).
 */
export async function getCachedQuery(
  engine: Engine,
  key: string,
  clockValue: number,
): Promise<CachedQuery | null> {
  const r = await engine.query<{ intent: string | null; result_ids: unknown }>(
    `SELECT qc.intent, qc.result_ids
       FROM query_cache qc
      WHERE qc.cache_key = $1 AND ${cacheFreshClause("$2")}`,
    [key, clockValue],
  );
  const row = r.rows[0];
  if (!row) return null;
  const ids = Array.isArray(row.result_ids)
    ? (row.result_ids as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
  if (ids.length === 0) return null;
  return { intent: row.intent, resultIds: ids };
}

export interface CacheStats {
  /** Total cached rows. */
  total: number;
  /** Rows still servable under the two-layer gate (Layer 1 OR Layer 2). */
  fresh: number;
  /** Rows invalidated under BOTH layers (clock advanced AND a referenced doc changed/deleted, or an empty snapshot behind an advanced clock). */
  stale: number;
  /** The current document-generation clock the stats were taken against. */
  current_clock: number;
  /** Distinct intent labels present in the cache. */
  distinct_intents: number;
  oldest_created_at: string | null;
  newest_created_at: string | null;
}

/** Read-only cache health: total / fresh / stale relative to the current clock. */
export async function cacheStats(
  engine: Engine,
  currentClock: number,
): Promise<CacheStats> {
  const r = await engine.query<{
    total: number | string;
    fresh: number | string;
    stale: number | string;
    distinct_intents: number | string;
    oldest: string | null;
    newest: string | null;
  }>(
    `SELECT
       COUNT(*)::int                                          AS total,
       COUNT(*) FILTER (WHERE ${cacheFreshClause("$1")})::int     AS fresh,
       COUNT(*) FILTER (WHERE NOT ${cacheFreshClause("$1")})::int AS stale,
       COUNT(DISTINCT qc.intent)::int                         AS distinct_intents,
       MIN(qc.created_at)::text                               AS oldest,
       MAX(qc.created_at)::text                               AS newest
     FROM query_cache qc`,
    [currentClock],
  );
  const row = r.rows[0];
  const toInt = (v: unknown): number => {
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : 0;
  };
  return {
    total: toInt(row?.total),
    fresh: toInt(row?.fresh),
    stale: toInt(row?.stale),
    current_clock: currentClock,
    distinct_intents: toInt(row?.distinct_intents),
    oldest_created_at: row?.oldest ?? null,
    newest_created_at: row?.newest ?? null,
  };
}

/** Delete every cached row. Returns the number removed. */
export async function clearCache(engine: Engine): Promise<number> {
  const r = await engine.query<{ n: number | string }>(
    `WITH d AS (DELETE FROM query_cache RETURNING 1) SELECT COUNT(*)::int AS n FROM d`,
  );
  const n = r.rows[0]?.n;
  return typeof n === "number" ? n : Number(n) || 0;
}

/**
 * Delete only rows invalidated under the two-layer gate (NOT fresh). Frees
 * space without dropping rows that are still servable via Layer 2 (a row whose
 * clock is stale but whose referenced documents are all unchanged stays).
 * Returns the number removed.
 */
export async function pruneCache(
  engine: Engine,
  currentClock: number,
): Promise<number> {
  const r = await engine.query<{ n: number | string }>(
    `WITH d AS (
       DELETE FROM query_cache qc WHERE NOT ${cacheFreshClause("$1")} RETURNING 1
     ) SELECT COUNT(*)::int AS n FROM d`,
    [currentClock],
  );
  const n = r.rows[0]?.n;
  return typeof n === "number" ? n : Number(n) || 0;
}

/**
 * Upsert a ranking into the cache, stamped with the current clock AND a
 * per-document generation snapshot (Layer 2, migration 031).
 *
 * `documentIds` are the documents the result chunks belong to (pass the
 * distinct `documentId` of each ranked hit). The snapshot
 * `{document_id: generation}` is built in the same statement via a subquery
 * over `documents`, so it is a consistent read of each doc's current
 * generation. An empty `documentIds` (e.g. an empty-result query) stores `{}`,
 * which relies on Layer 1 exclusively (see module docs).
 *
 * Race guard: the row is persisted ONLY when the live document clock still
 * equals `clockValue` (the value the caller read before ranking). `clockValue`,
 * the clock re-check, and the generation snapshot are all evaluated in ONE
 * statement under a single MVCC snapshot, so they are mutually consistent. If
 * any document write committed between the caller's clock read and this write,
 * the live clock has advanced past `clockValue` and the INSERT writes nothing —
 * we must not stamp a ranking computed against the old corpus with a snapshot
 * of the new corpus (which Layer 2 could then wrongly accept as fresh). This
 * preserves the pre-two-layer guarantee that a mid-search write never produces
 * a servable-but-stale cache row.
 */
export async function putCachedQuery(
  engine: Engine,
  key: string,
  query: string,
  k: number,
  intent: string | null,
  resultIds: readonly string[],
  clockValue: number,
  documentIds: readonly string[] = [],
): Promise<void> {
  await engine.query(
    `INSERT INTO query_cache (cache_key, query, k, intent, result_ids, clock_value, doc_generations)
     SELECT $1, $2, $3, $4, $5::jsonb, $6,
       COALESCE(
         (SELECT jsonb_object_agg(d.id, d.generation)
            FROM documents d WHERE d.id = ANY($7::text[])),
         '{}'::jsonb)
     WHERE COALESCE((SELECT value FROM document_generation_clock WHERE id = 1), 0) = $6
     ON CONFLICT (cache_key) DO UPDATE SET
       intent          = EXCLUDED.intent,
       result_ids      = EXCLUDED.result_ids,
       clock_value     = EXCLUDED.clock_value,
       doc_generations = EXCLUDED.doc_generations,
       created_at      = NOW()`,
    [
      key,
      query,
      k,
      intent,
      JSON.stringify([...resultIds]),
      clockValue,
      [...documentIds],
    ],
  );
}
