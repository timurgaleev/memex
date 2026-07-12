/**
 * Quarantine — a frontmatter marker (no DB column) that hides a document from
 * search without deleting it. Two-tier model:
 *
 *   * `quarantine`   — HIDE: high-confidence junk; excluded from search.
 *   * `content_flag` — WARN: stays searchable; surfaced to the reader, no SQL
 *                      filter. (Marker only; consumers may render a warning.)
 *
 * Quarantine lives in `documents.frontmatter` (JSONB), so it needs no schema
 * change — the `? 'quarantine'` key test is the whole mechanism.
 */

export const QUARANTINE_KEY = "quarantine";
export const CONTENT_FLAG_KEY = "content_flag";

/**
 * Guard against SQL injection via a table alias. Aliases that feed string
 * interpolation must be plain SQL identifiers — never caller/user input. All
 * current callers pass a literal ('d'); this is defense-in-depth for any future
 * caller that forgets that contract.
 */
export function assertSqlAlias(alias: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) {
    throw new Error(`unsafe SQL alias: ${JSON.stringify(alias)}`);
  }
}

/** True when a frontmatter object carries the hide-from-search marker. */
export function isQuarantined(
  frontmatter: Record<string, unknown> | null | undefined,
): boolean {
  return !!frontmatter && Object.hasOwn(frontmatter, QUARANTINE_KEY);
}

/** True when a frontmatter object carries the warn-but-show marker. */
export function isContentFlagged(
  frontmatter: Record<string, unknown> | null | undefined,
): boolean {
  return !!frontmatter && Object.hasOwn(frontmatter, CONTENT_FLAG_KEY);
}

/**
 * SQL fragment (a boolean expression, NO leading `AND`) that is true for
 * NON-quarantined documents. `docAlias` is the `documents` row alias in scope.
 * COALESCE guards a NULL frontmatter (treated as not-quarantined).
 */
export function quarantineFilterFragment(docAlias = "d"): string {
  assertSqlAlias(docAlias);
  return `NOT (COALESCE(${docAlias}.frontmatter, '{}'::jsonb) ? '${QUARANTINE_KEY}')`;
}
