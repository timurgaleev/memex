/**
 * content-flag.ts — surface a page's `content_flag` WARN marker on search hits.
 *
 * An agent-warning channel. The `content_flag` frontmatter
 * marker (the WARN tier of `quarantine.ts`, vs the HIDE tier `quarantine`)
 * leaves a page fully searchable but tells the agent "this looks odd
 * (markup-heavy / oversize) — examine it before trusting it".
 *
 * Post-fusion + best-effort, mirroring memex's `stampEvidence` precedent: one
 * batched query over the FINAL sliced hits' document ids (bounded by `k`, not
 * the candidate pool), and a fetch failure never breaks retrieval.
 *
 * Stack design: memex search is chunk→`documents`-keyed, the marker
 * lives on `documents.frontmatter.content_flag`, document ids are TEXT, and
 * memex's unified `engine.query` takes the SQL directly. `reason`/`detail` are
 * extracted in SQL with `->>`.
 */
import type { Engine } from "../engine/interface.ts";
import type { SearchHit } from "./hybrid.ts";

export interface ContentFlag {
  reason: string;
  detail: string;
}

/**
 * Read the `{reason, detail}` content_flag for a set of document ids: a row
 * with no `reason` is skipped, `detail` defaults to ''.
 */
async function getContentFlagsByDocumentIds(
  engine: Engine,
  ids: string[],
): Promise<Map<string, ContentFlag>> {
  const result = new Map<string, ContentFlag>();
  if (ids.length === 0) return result;
  const r = await engine.query<{ id: string; reason: string | null; detail: string | null }>(
    `SELECT id,
            frontmatter -> 'content_flag' ->> 'reason' AS reason,
            frontmatter -> 'content_flag' ->> 'detail' AS detail
       FROM documents
      WHERE id = ANY($1::text[])
        AND frontmatter ? 'content_flag'`,
    [ids],
  );
  for (const row of r.rows) {
    if (!row.reason) continue;
    result.set(row.id, { reason: row.reason, detail: row.detail ?? "" });
  }
  return result;
}

/**
 * Attach `content_flag` to any hit whose document carries the marker. Mutates
 * the hits in place (the `stampEvidence` precedent). No-op on an empty set, and
 * fail-open: any error leaves the results unflagged rather than breaking search.
 */
export async function stampContentFlags(engine: Engine, hits: SearchHit[]): Promise<void> {
  if (hits.length === 0) return;
  try {
    const ids = [...new Set(hits.map((h) => h.documentId))];
    if (ids.length === 0) return;
    const flags = await getContentFlagsByDocumentIds(engine, ids);
    if (flags.size === 0) return;
    for (const h of hits) {
      const f = flags.get(h.documentId);
      if (f) h.content_flag = f;
    }
  } catch {
    // best-effort: a flag-fetch failure must not break retrieval.
  }
}
