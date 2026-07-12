/**
 * Embed-skip — a frontmatter marker (no DB column) that excludes a document
 * from EMBEDDING while leaving it fully searchable via the keyword arm.
 * Sibling to the `quarantine`/`content_flag` markers in `quarantine.ts`:
 *
 *   * `quarantine`   — HIDE from search (visibility filter).
 *   * `content_flag` — WARN but stay searchable (marker only).
 *   * `embed_skip`   — INDEX + keyword-search normally, but never embed.
 *
 * A page carries the marker when its body is unsuitable for the vector arm
 * (e.g. oversized — the deferred content-sanity writer stamps it) or when the
 * operator hand-declares `embed_skip` in the markdown frontmatter. Either way
 * the predicate is key-existence: marker CONTENTS are diagnostic, not
 * functional, so a future marker-shape change never breaks the filter.
 *
 * Two surfaces:
 *   - `isEmbedSkipped(frontmatter)` for callers holding an in-memory page
 *     object (the inline indexer embed path).
 *   - `embedSkipFilterFragment(docAlias)` for callers splicing into ranking /
 *     backfill SQL (the missing-chunk embed path). The fragment targets the
 *     `documents` row — memex embeds CHUNKS joined to their document, and the
 *     markdown frontmatter lands on `documents.frontmatter` at index time.
 *
 * Faithful note: only the embed PATHS honour this marker. The embed-coverage
 * METRIC (source-health / advisor) still counts an embed-skip page's chunks in
 * its denominator — the coverage metric does not filter the marker. An operator
 * with embed-skip pages accepts a coverage number below 100%, or splits the
 * page.
 *
 * Scope: this is a CHUNK marker. The page's `## Facts`
 * fence still embeds into `entity_facts.embedding` (a separate derived vector
 * arm, stripped before chunking) — `embed_skip` is "don't embed this page's
 * chunks", not "no vector arm at all".
 *
 * Writer contract: the marker takes effect at INDEX time (the indexer skips the
 * embed, the indexer-tx cascade wipes any prior chunk vectors). A future writer
 * that stamps `embed_skip` MUST reindex the page (or delete its embedding rows)
 * — a bare `UPDATE documents SET frontmatter` would leave stale vectors that the
 * backfill filter then refuses to touch, so they would keep surfacing.
 */
import { assertSqlAlias } from "./quarantine.ts";

/** The frontmatter key name. Stable contract — renaming it means rewriting
 *  every consumer of the skip semantic. */
export const EMBED_SKIP_KEY = "embed_skip";

/** True when a frontmatter object carries the embed-skip marker. Accepts a
 *  null/undefined frontmatter (some paths build page objects without one) and
 *  returns false. Mirrors the SQL fragment's key-existence semantics. */
export function isEmbedSkipped(
  frontmatter: Record<string, unknown> | null | undefined,
): boolean {
  return !!frontmatter && Object.hasOwn(frontmatter, EMBED_SKIP_KEY);
}

/**
 * SQL fragment (a boolean expression, NO leading `AND`) that is true for
 * documents WITHOUT the embed-skip marker — i.e. the ones that SHOULD be
 * embedded. `docAlias` is the `documents` row alias in scope. COALESCE guards a
 * NULL frontmatter (treated as not-skipped). The JSONB `?` key-existence
 * operator is unambiguous under memex's `$N` placeholders (no `?` clash).
 */
export function embedSkipFilterFragment(docAlias = "d"): string {
  assertSqlAlias(docAlias);
  return `NOT (COALESCE(${docAlias}.frontmatter, '{}'::jsonb) ? '${EMBED_SKIP_KEY}')`;
}
