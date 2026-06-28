/**
 * chunker-version.ts — re-chunk staleness over `documents.chunker_version`
 * (migration 052).
 *
 * A document is STALE for re-chunking when its stamped chunker version is below
 * the CURRENT version of the chunker that produced it. The two chunkers carry
 * independent version namespaces (markdown vs code), so the staleness check
 * branches on document kind. The reference positively gates `page_kind='markdown'`;
 * memex treats markdown as the NEGATION of code (`frontmatter->>'kind' <> 'code'`)
 * because markdown frontmatter is user-shaped and usually carries no `kind`. This
 * holds for memex's two-kind (markdown + code) corpus — if a third doc kind is
 * ever indexed it would fall into the markdown comparison; split the predicate
 * then.
 *
 * DETECT-ONLY (stack difference, same as the LINK_EXTRACTOR_VERSION watermark):
 * this only COUNTS stale docs. The reference's post-upgrade flow also TRIGGERS a
 * re-embed sweep; memex has no such sweep, so a bumped chunker constant raises
 * the doctor count but performs no work — a stale doc re-chunks lazily on its
 * next natural reindex. A batch re-chunk sweep is the shared follow-up (TODO).
 */
import type { Engine } from "./engine/interface.ts";
import { MARKDOWN_CHUNKER_VERSION } from "./chunkers/recursive.ts";
import { CODE_CHUNKER_VERSION } from "./chunkers/code.ts";

/**
 * Count live documents whose chunks predate the current chunker version for
 * their kind. Single engine.query (no postgres/PGLite branch). Soft-deleted
 * documents are excluded.
 */
export async function countStaleChunkerDocs(engine: Engine): Promise<number> {
  const r = await engine.query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM documents d
      WHERE d.deleted_at IS NULL
        AND (
          (COALESCE(d.frontmatter->>'kind','') = 'code'  AND d.chunker_version < $1)
          OR
          (COALESCE(d.frontmatter->>'kind','') <> 'code' AND d.chunker_version < $2)
        )`,
    [CODE_CHUNKER_VERSION, MARKDOWN_CHUNKER_VERSION],
  );
  return r.rows[0]?.n ?? 0;
}
