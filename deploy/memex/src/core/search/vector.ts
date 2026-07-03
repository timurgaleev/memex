/**
 * Vector retrieval — pure pgvector cosine similarity.
 *
 * Returns chunk_ids ordered by distance ascending (closer = better).
 * Both PGLite and Postgres support `<=>` cosine operator from pgvector.
 */
import type { Engine } from "../engine/interface.ts";
import { visibilityClause } from "../visibility.ts";
import { chunkFilterClauses, type ChunkFilters } from "./filters.ts";

export interface VectorSearchOptions {
  /** Optional source-id filter — only return chunks whose parent doc
   *  belongs to one of these sources. Default: no filter. */
  sourceIds?: readonly string[];
  /**
   * Pushed-down lang / symbol_kind / since / until predicates. Folded into the
   * WHERE clause so the ANN LIMIT budget is spent on rows that already match.
   * See filters.ts.
   */
  filters?: ChunkFilters;
}

export async function vectorSearch(
  engine: Engine,
  queryVector: number[],
  limit: number,
  opts: VectorSearchOptions = {},
): Promise<string[]> {
  const sourceIds = opts.sourceIds ?? [];
  const vis = visibilityClause("d");
  // Join chunks→documents so the visibility filter applies to the ANN arm too.
  // Exclusions (deleted/archived/quarantined) are rare, so the filtered scan
  // barely dents recall; correctness (never surfacing hidden docs) wins.
  const params: unknown[] = [JSON.stringify(queryVector)];
  let sourceFilter = "";
  if (sourceIds.length > 0) {
    params.push(sourceIds);
    sourceFilter = ` AND d.source_id = ANY($${params.length}::text[])`;
  }
  const filterClauses = chunkFilterClauses(params, opts.filters);
  params.push(limit);
  const limitParam = `$${params.length}`;
  const r = await engine.query<{ chunk_id: string }>(
    `SELECT e.chunk_id FROM embeddings e
     JOIN chunks c     ON c.id = e.chunk_id
     JOIN documents d  ON d.id = c.document_id
     WHERE ${vis}${sourceFilter}${filterClauses}
     ORDER BY e.vector <=> $1::vector
     LIMIT ${limitParam}`,
    params,
  );
  return r.rows.map((row) => row.chunk_id);
}
