/**
 * Search visibility filter — the single source of truth for which documents
 * are eligible to appear in search results.
 *
 * A document is hidden when it is soft-deleted, archived, or quarantined.
 * The fragment is spliced
 * (with a leading `AND`) into every ranking SQL (keyword + vector arms) so the
 * exclusion can never be bypassed by a detail/verbosity flag — it sits in the
 * WHERE, not the post-processing.
 *
 *   * deleted_at IS NOT NULL        → soft-deleted (awaiting 72h hard purge)
 *   * archived = true               → source archived (awaiting expiry)
 *   * frontmatter ? 'quarantine'    → high-confidence junk marker (no column)
 */
import { quarantineFilterFragment, assertSqlAlias } from "./quarantine.ts";

/**
 * Returns a SQL boolean expression (NO leading `AND`) that is true only for
 * VISIBLE documents. Caller passes the alias of the `documents` row in scope.
 */
export function visibilityClause(docAlias = "d"): string {
  assertSqlAlias(docAlias);
  return (
    `${docAlias}.deleted_at IS NULL ` +
    `AND NOT ${docAlias}.archived ` +
    `AND ${quarantineFilterFragment(docAlias)}`
  );
}
