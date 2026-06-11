/**
 * Keyword retrieval — tsvector plainto_tsquery + ts_rank_cd.
 *
 * Ranks against the weighted `search_vector` (migration 030): a chunk's
 * symbol identity (symbol_name + parent_symbol_path, code chunks only) sits
 * at weight 'A' above its body text at weight 'B', so a query that names a
 * symbol ranks that chunk above prose-only mentions. Markdown chunks have an
 * empty 'A' segment, so their lexemes all land at 'B' — a uniform shift that
 * leaves their relative order unchanged. Config stays 'simple', so the
 * matched set is identical to the old un-weighted `ts` for markdown chunks.
 *
 * NOTE: that order-preservation for markdown holds ONLY because `ts_rank_cd`
 * is called with no normalization flag — a uniform per-lexeme weight shift
 * then scales every markdown doc's rank by the same constant. If a
 * length-normalization flag (e.g. `| 2`) is ever added here, the factor stops
 * cancelling and markdown ordering can shift; re-validate the retrieval gates
 * before doing so.
 *
 * Both engines treat the `to_tsvector('simple', ...)` GENERATED column the
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
       WHERE search_vector @@ plainto_tsquery('simple', $1)
       ORDER BY ts_rank_cd(search_vector, plainto_tsquery('simple', $1)) DESC, id COLLATE "C" ASC
       LIMIT $2`,
      [query, limit],
    );
    return r.rows.map((row) => row.id);
  }
  const r = await engine.query<{ id: string }>(
    `SELECT c.id FROM chunks c
     JOIN documents d ON d.id = c.document_id
     WHERE c.search_vector @@ plainto_tsquery('simple', $1)
       AND d.source_id = ANY($2::text[])
     ORDER BY ts_rank_cd(c.search_vector, plainto_tsquery('simple', $1)) DESC, c.id COLLATE "C" ASC
     LIMIT $3`,
    [query, sourceIds, limit],
  );
  return r.rows.map((row) => row.id);
}
