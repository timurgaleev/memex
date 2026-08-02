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
import { OperationError } from "../operation-error.ts";

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

const RELATIVE_DURATION = /^(\d+)([dwmy])$/;
const PLAIN_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
const UNIT_DAYS: Record<string, number> = { d: 1, w: 7, m: 30, y: 365 };

/**
 * Normalize a since/until bound to an ISO-8601 timestamp:
 * - relative durations ("7d" / "2w" / "6m" / "1y") subtract from now
 *   (m = 30 days, y = 365 — a lookback window, not calendar arithmetic);
 * - a plain YYYY-MM-DD `until` maps to end-of-day (T23:59:59.999Z) so the
 *   bound includes that whole day instead of cutting at midnight;
 * - anything else Date.parse accepts passes through unchanged.
 * Garbage throws — a silently-dropped bound would widen the result set.
 */
export function resolveDateBoundary(value: string, which: "since" | "until"): string {
  const v = value.trim();
  const rel = RELATIVE_DURATION.exec(v);
  if (rel) {
    const days = Number(rel[1]) * UNIT_DAYS[rel[2] as string]!;
    return new Date(Date.now() - days * DAY_MS).toISOString();
  }
  if (which === "until" && PLAIN_DATE.test(v)) return `${v}T23:59:59.999Z`;
  // Pin a plain-date `since` to UTC midnight too — a raw date would be cast in
  // the server's session TZ by Postgres while the post-hydrate path parses it
  // as UTC; the two must agree regardless of server TZ.
  if (PLAIN_DATE.test(v)) return `${v}T00:00:00.000Z`;
  if (Number.isNaN(Date.parse(v))) {
    throw new OperationError(
      "invalid_params",
      `Invalid ${which} value "${value}"`,
      "Use ISO-8601 (e.g. 2026-01-15) or a relative duration (7d / 2w / 6m / 1y).",
    );
  }
  return v;
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
    params.push(resolveDateBoundary(f.since, "since"));
    sql += ` AND COALESCE(d.effective_date, d.updated_at) >= $${params.length}::timestamptz`;
  }
  if (f.until) {
    params.push(resolveDateBoundary(f.until, "until"));
    sql += ` AND COALESCE(d.effective_date, d.updated_at) <= $${params.length}::timestamptz`;
  }
  return sql;
}
