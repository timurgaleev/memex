/**
 * empty-source — a frontmatter marker (no DB column) the CODE indexer stamps on
 * a document whose source file carries no indexable content at all: a tracked
 * 0-byte or whitespace-only file. Sibling to the markers in `quarantine.ts` and
 * `embed-skip.ts`, but UNLIKE them the predicate reads the VALUE and requires
 * exactly `true`. Frontmatter is author-controlled and arrives from remote
 * ingest untouched, so an existence test would let `empty_source: false` buy an
 * exemption from the corruption flag this marker guards.
 *
 * Why it exists: `indexCodeDocument`'s symbol-less fallback windows the body as
 * plain text, but only when there IS a body (`text.trim().length > 0`). A blank
 * file therefore lands in the DB as a document with zero chunks — exactly the
 * shape `orphans-purge` reports as "corrupt index — re-run the indexer". But
 * re-running the indexer yields the same zero chunks, so the flag is a fixpoint:
 * one committed empty file pins the phase at `warn` for the life of that file
 * and buries any genuinely corrupt row in the same list.
 *
 * The marker moves the call to the only place that can tell the two apart — the
 * indexer knows whether the zero chunks came from blank input or from a write
 * that produced nothing. Filtering at sweep time instead (skip 0-byte sources)
 * was the other candidate and is worse: it would leave the chunks of a file
 * TRUNCATED to empty in place, so the brain keeps serving content that is no
 * longer on disk, and it would still miss whitespace-only files.
 *
 * The marker cannot go stale. A re-index rebuilds a code document's frontmatter
 * wholesale (`{ language, kind }`), so the key disappears the moment the file
 * gains content. It also grants nothing — it only suppresses a report line.
 */
import { assertSqlAlias } from "./quarantine.ts";

/** The frontmatter key name. Stable contract, shared by writer and reader. */
export const EMPTY_SOURCE_KEY = "empty_source";

/**
 * SQL fragment (a boolean expression, NO leading `AND`) that is true for
 * documents WITHOUT the empty-source marker — the ones for which zero chunks is
 * a real anomaly. `docAlias` is the `documents` row alias in scope. COALESCE
 * guards a NULL frontmatter (treated as not-marked).
 */
export function notEmptySourceFragment(docAlias = "d"): string {
  assertSqlAlias(docAlias);
  // The marker must be exactly `true`, not merely PRESENT. Frontmatter is
  // author-controlled and rides in from remote ingest untouched, so a key test
  // alone lets `empty_source: false` — or any other value — buy an exemption
  // from the corruption flag this predicate guards.
  return `COALESCE(${docAlias}.frontmatter, '{}'::jsonb) -> '${EMPTY_SOURCE_KEY}' IS DISTINCT FROM 'true'::jsonb`;
}
