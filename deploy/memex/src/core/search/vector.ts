/**
 * Vector retrieval — pure pgvector cosine similarity.
 *
 * Returns chunk_ids ordered by distance ascending (closer = better).
 * Both PGLite and Postgres support `<=>` cosine operator from pgvector.
 */
import type { Engine } from "../engine/interface.ts";
import { visibilityClause } from "../visibility.ts";

export interface VectorSearchOptions {
  /** Optional source-id filter — only return chunks whose parent doc
   *  belongs to one of these sources. Default: no filter. */
  sourceIds?: readonly string[];
}

export async function vectorSearch(
  engine: Engine,
  queryVector: number[],
  limit: number,
  opts: VectorSearchOptions = {},
): Promise<string[]> {
  const sourceIds = opts.sourceIds ?? [];
  const vis = visibilityClause("d");
  if (sourceIds.length === 0) {
    // Join chunks→documents so the visibility filter applies to the ANN arm
    // too. Exclusions (deleted/archived/quarantined) are rare, so the filtered
    // scan barely dents recall; correctness (never surfacing hidden docs) wins.
    const r = await engine.query<{ chunk_id: string }>(
      `SELECT e.chunk_id FROM embeddings e
       JOIN chunks c     ON c.id = e.chunk_id
       JOIN documents d  ON d.id = c.document_id
       WHERE ${vis}
       ORDER BY e.vector <=> $1::vector
       LIMIT $2`,
      [JSON.stringify(queryVector), limit],
    );
    return r.rows.map((row) => row.chunk_id);
  }
  const r = await engine.query<{ chunk_id: string }>(
    `SELECT e.chunk_id FROM embeddings e
     JOIN chunks c     ON c.id = e.chunk_id
     JOIN documents d  ON d.id = c.document_id
     WHERE d.source_id = ANY($2::text[])
       AND ${vis}
     ORDER BY e.vector <=> $1::vector
     LIMIT $3`,
    [JSON.stringify(queryVector), sourceIds, limit],
  );
  return r.rows.map((row) => row.chunk_id);
}
