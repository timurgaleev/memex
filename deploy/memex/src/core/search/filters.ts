/**
 * Pushed-down retrieval filters — lang / symbol_kind / since / until predicates
 * folded into the keyword (ts_rank_cd) and vector (pgvector) SQL WHERE clauses.
 *
 * Applying these at the SQL layer (rather than post-hydrate over the fanout
 * candidate pool) means the per-arm LIMIT budget is spent on rows that already
 * match: a filtered query whose matches rank below the fanout no longer returns
 * fewer than k (or zero) when matching content exists.
 *
 * since/until bound the SAME content-date axis the ranking uses —
 * COALESCE(effective_date, updated_at) — cast to timestamptz so the compare is
 * temporal, never a lexical string compare across the "…T…" vs "… …+00" gap.
 */

export interface ChunkFilters {
  /** chunks.language (e.g. "typescript"). */
  lang?: string;
  /** chunks.symbol_type (e.g. "function"). */
  symbolKind?: string;
  /** Keep docs whose content date is >= this ISO date. */
  since?: string;
  /** Keep docs whose content date is <= this ISO date. */
  until?: string;
}

/** True when at least one filter axis is set. */
export function hasChunkFilters(f: ChunkFilters | undefined): boolean {
  return Boolean(f && (f.lang || f.symbolKind || f.since || f.until));
}

/**
 * Append filter predicates to a growing positional-parameter array, returning
 * the SQL fragment (each clause prefixed " AND "). Column refs assume the caller
 * aliases chunks as `c` and documents as `d` — both keyword.ts and vector.ts do.
 * A no-op (empty string, no params pushed) when no axis is set.
 */
export function chunkFilterClauses(params: unknown[], f: ChunkFilters | undefined): string {
  if (!f) return "";
  let sql = "";
  if (f.lang) {
    params.push(f.lang);
    sql += ` AND c.language = $${params.length}`;
  }
  if (f.symbolKind) {
    params.push(f.symbolKind);
    sql += ` AND c.symbol_type = $${params.length}`;
  }
  if (f.since) {
    params.push(f.since);
    sql += ` AND COALESCE(d.effective_date, d.updated_at) >= $${params.length}::timestamptz`;
  }
  if (f.until) {
    params.push(f.until);
    sql += ` AND COALESCE(d.effective_date, d.updated_at) <= $${params.length}::timestamptz`;
  }
  return sql;
}
