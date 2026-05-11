/**
 * Keyword retrieval — tsvector plainto_tsquery + ts_rank_cd.
 *
 * Both engines treat `to_tsvector('simple', ...)` GENERATED column the
 * same way. `plainto_tsquery` lowercases / strips operators so callers
 * can pass user input verbatim.
 */
import type { Engine } from "../engine/interface.ts";

export interface KeywordSearchOptions {
  sourceIds?: readonly string[];
}

export async function keywordSearch(
  engine: Engine,
  query: string,
  limit: number,
  opts: KeywordSearchOptions = {},
): Promise<string[]> {
  const sourceIds = opts.sourceIds ?? [];
  if (sourceIds.length === 0) {
    const r = await engine.query<{ id: string }>(
      `SELECT id FROM chunks
       WHERE ts @@ plainto_tsquery('simple', $1)
       ORDER BY ts_rank_cd(ts, plainto_tsquery('simple', $1)) DESC
       LIMIT $2`,
      [query, limit],
    );
    return r.rows.map((row) => row.id);
  }
  const r = await engine.query<{ id: string }>(
    `SELECT c.id FROM chunks c
     JOIN documents d ON d.id = c.document_id
     WHERE c.ts @@ plainto_tsquery('simple', $1)
       AND d.source_id = ANY($2::text[])
     ORDER BY ts_rank_cd(c.ts, plainto_tsquery('simple', $1)) DESC
     LIMIT $3`,
    [query, sourceIds, limit],
  );
  return r.rows.map((row) => row.id);
}
