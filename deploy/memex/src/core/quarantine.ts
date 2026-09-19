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

import type { Engine } from "./engine/interface.ts";
import { logIngest } from "./ingest-log.ts";
import { describeQuarantineTrip, type ContentSanityResult } from "./content-sanity.ts";

export const QUARANTINE_KEY = "quarantine";

/** `ingest_log.source_type` of a content-sanity trip. */
export const QUARANTINE_AUDIT_SOURCE_TYPE = "quarantine";
export const CONTENT_FLAG_KEY = "content_flag";

/**
 * Guard against SQL injection via a table alias. Aliases that feed string
 * interpolation must be plain SQL identifiers — never caller/user input. All
 * current callers pass a literal ('d'); this is defense-in-depth for any future
 * caller that forgets that contract.
 */
export function assertSqlAlias(alias: string): void {
  if (!/^[a-z_]\w*$/i.test(alias)) {
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

/**
 * One `ingest_log` row per quarantine trip, so a false positive that hides a
 * page leaves a trail naming the pattern that fired. The summary carries the
 * pattern names only, never the matched text: an operator literal can be a
 * string the operator does not want echoed back.
 */
export async function auditQuarantine(
  engine: Engine,
  result: ContentSanityResult,
  ref: string,
  sourceId: string | null,
): Promise<void> {
  if (!result.shouldQuarantine) return;
  await logIngest(engine, {
    source_type: QUARANTINE_AUDIT_SOURCE_TYPE,
    source_ref: ref,
    summary: describeQuarantineTrip(result),
    ...(sourceId ? { source_id: sourceId } : {}),
  });
}
