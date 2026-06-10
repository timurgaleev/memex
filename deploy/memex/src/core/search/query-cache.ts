/**
 * Exact-match query cache (migration 026).
 *
 * A cache hit returns a previously-computed ranking for an identical query,
 * letting the caller skip embedding + intent classification + retrieval +
 * fusion entirely. Validity is gated on the live-model
 * `document_generation_clock`: a row is only honoured when its `clock_value`
 * matches the current clock, so any document write invalidates the cache
 * for free (migration 025).
 *
 * The cache stores ordered chunk ids, NOT content — on a hit the caller
 * re-hydrates from the live tables, so returned text is always current.
 *
 * Every function is safe to wrap in try/catch by the caller: the cache is a
 * pure optimization and a failure must fall through to a normal search.
 */
import { createHash } from "node:crypto";
import type { Engine } from "../engine/interface.ts";

export interface CachedQuery {
  intent: string | null;
  resultIds: string[];
}

/**
 * Deterministic cache key. Includes everything that changes the ranking
 * output: normalized query text, k, the (order-independent) source scope,
 * and whether reranking is on. Intent + expansion are derived from the
 * query and therefore already implied by it.
 */
export function queryCacheKey(
  query: string,
  k: number,
  sourceIds: readonly string[] | undefined,
  rerank: boolean,
): string {
  const scope = sourceIds && sourceIds.length > 0
    ? [...sourceIds].map((s) => s.toLowerCase()).sort()
    : [];
  const material = JSON.stringify([
    query.trim().toLowerCase().replace(/\s+/g, " "),
    k,
    scope,
    rerank ? 1 : 0,
  ]);
  return createHash("sha256").update(material).digest("hex");
}

/** Return the cached ranking iff it exists AND matches the current clock. */
export async function getCachedQuery(
  engine: Engine,
  key: string,
  clockValue: number,
): Promise<CachedQuery | null> {
  const r = await engine.query<{ intent: string | null; result_ids: unknown }>(
    `SELECT intent, result_ids
       FROM query_cache
      WHERE cache_key = $1 AND clock_value = $2`,
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
  /** Rows whose clock matches the current document clock (still servable). */
  fresh: number;
  /** Rows stranded behind an older clock (a doc write has since invalidated them). */
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
       COUNT(*)::int                                  AS total,
       COUNT(*) FILTER (WHERE clock_value = $1)::int  AS fresh,
       COUNT(*) FILTER (WHERE clock_value <> $1)::int AS stale,
       COUNT(DISTINCT intent)::int                    AS distinct_intents,
       MIN(created_at)::text                          AS oldest,
       MAX(created_at)::text                          AS newest
     FROM query_cache`,
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
 * Delete only the stale rows (clock_value <> the current clock). Frees space
 * without dropping rows that are still servable. Returns the number removed.
 */
export async function pruneCache(
  engine: Engine,
  currentClock: number,
): Promise<number> {
  const r = await engine.query<{ n: number | string }>(
    `WITH d AS (
       DELETE FROM query_cache WHERE clock_value <> $1 RETURNING 1
     ) SELECT COUNT(*)::int AS n FROM d`,
    [currentClock],
  );
  const n = r.rows[0]?.n;
  return typeof n === "number" ? n : Number(n) || 0;
}

/** Upsert a ranking into the cache, stamped with the current clock. */
export async function putCachedQuery(
  engine: Engine,
  key: string,
  query: string,
  k: number,
  intent: string | null,
  resultIds: readonly string[],
  clockValue: number,
): Promise<void> {
  await engine.query(
    `INSERT INTO query_cache (cache_key, query, k, intent, result_ids, clock_value)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)
     ON CONFLICT (cache_key) DO UPDATE SET
       intent      = EXCLUDED.intent,
       result_ids  = EXCLUDED.result_ids,
       clock_value = EXCLUDED.clock_value,
       created_at  = NOW()`,
    [key, query, k, intent, JSON.stringify([...resultIds]), clockValue],
  );
}
