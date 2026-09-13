/**
 * Source scope — the one reading of a caller's `sourceIds` every read path uses.
 *
 *   undefined        → unscoped (operator, local CLI): no predicate at all
 *   []               → a caller granted nothing: reads NOTHING
 *   [NO_SOURCE_SENTINEL] → same as [] (the ingress fail-closed floor)
 *   ['a', 'b']       → only those sources
 *
 * The trap this module exists to close: `if (sourceIds && sourceIds.length)`
 * treats `[]` exactly like `undefined`, so a caller with no grant silently reads
 * the whole brain. Test `!== undefined`, or build the SQL here.
 */
import { NO_SOURCE_SENTINEL } from "./auth-info.ts";
import { assertSqlAlias } from "./quarantine.ts";

export type SourceScope = readonly string[] | undefined;

/** True for a caller that may read no source at all. */
export function isNoGrant(scope: SourceScope): boolean {
  return scope !== undefined && scope.every(s => s === NO_SOURCE_SENTINEL);
}

/**
 * Clean a scope for a bound `$n::text[]`: drop blanks, dedupe. Keeps `undefined`
 * unscoped and keeps an empty grant empty.
 */
export function normalizeScope(scope: SourceScope): string[] | undefined {
  if (!Array.isArray(scope)) return undefined;
  return Array.from(new Set(scope.filter((s) => typeof s === "string" && s.length > 0)));
}

/**
 * ` AND <col> = ANY($n::text[])` for a scoped caller, ` AND FALSE` for one with
 * no grant (`[]` or the sentinel — never a lookup of the sentinel id), and `""` when unscoped — so the operator's SQL text is unchanged.
 * Pushes the bound array onto `params` only when a predicate is emitted.
 */
export function andSourceScope(col: string, scope: SourceScope, params: unknown[]): string {
  for (const part of col.split(".")) assertSqlAlias(part);
  if (scope === undefined) return "";
  if (isNoGrant(scope)) return " AND FALSE";
  params.push([...scope]);
  return ` AND ${col} = ANY($${params.length}::text[])`;
}

/**
 * Parse boundary for a USER-supplied source filter (a CLI flag, a fixture): an
 * empty or blank list means "no filter given", never "match nothing". Auth-derived
 * scopes must not pass through here.
 */
export function normalizeSourceFilterParam(value: readonly string[] | undefined): string[] | undefined {
  const ids = (value ?? []).map(s => s.trim()).filter(Boolean);
  return ids.length > 0 ? ids : undefined;
}
