/**
 * reconcile-links phase — find wikilinks that don't resolve to any
 * document, report them so a human (or a follow-up command) can fix.
 *
 * Strategy:
 *   1. Pull all entities of type='wikilink'.
 *   2. For each, attempt resolution: an entity name resolves if there's
 *      a document whose title matches (case-insensitive trim) or whose
 *      source_path ends with `<name>.md`.
 *   3. Unresolved entities go in the report. We do NOT mutate; the
 *      `reconcile-links` command (interactive) does mutations.
 */
import type { Engine } from "../engine/interface.ts";

export interface ReconcileLinksResult {
  totalWikilinks: number;
  resolved: number;
  unresolved: { name: string; mentionCount: number }[];
}

export async function reconcileLinksPhase(
  engine: Engine,
  opts: { reportLimit?: number } = {},
): Promise<ReconcileLinksResult> {
  const reportLimit = opts.reportLimit ?? 100;

  const rows = await engine.query<{
    name: string;
    mention_count: number;
    has_doc_match: boolean;
  }>(
    `WITH wl AS (
       SELECT e.name,
              COUNT(em.chunk_id)::int AS mention_count
       FROM entities e
       LEFT JOIN entity_mentions em ON em.entity_id = e.id
       WHERE e.type = 'wikilink'
       GROUP BY e.name
     ),
     resolved AS (
       SELECT DISTINCT lower(trim(d.title)) AS title_norm,
              d.source_path
       FROM documents d
     )
     SELECT wl.name,
            wl.mention_count,
            EXISTS (
              SELECT 1 FROM resolved r
              WHERE r.title_norm = lower(trim(wl.name))
                 OR r.source_path ILIKE '%/' || wl.name || '.md'
            ) AS has_doc_match
     FROM wl
     ORDER BY wl.mention_count DESC, wl.name
     LIMIT $1`,
    [reportLimit + 50],
  );

  const total = rows.rows.length;
  let resolved = 0;
  const unresolved: { name: string; mentionCount: number }[] = [];
  for (const r of rows.rows) {
    if (r.has_doc_match) {
      resolved++;
    } else {
      unresolved.push({ name: r.name, mentionCount: r.mention_count });
    }
  }
  return {
    totalWikilinks: total,
    resolved,
    unresolved: unresolved.slice(0, reportLimit),
  };
}
