/**
 * Vector retrieval — pure pgvector cosine similarity.
 *
 * Returns chunk_ids ordered by distance ascending (closer = better).
 * Both PGLite and Postgres support `<=>` cosine operator from pgvector.
 */
import type { Engine } from "../engine/interface.ts";
import { visibilityClause } from "../visibility.ts";
import { chunkFilterClauses, type ChunkFilters } from "./filters.ts";
import {
  buildCurationBoostCaseSql,
  buildHardExcludeClauseSql,
} from "./curation.ts";

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
  /**
   * Per-page max-pool (opt-in, default OFF): collapse to ONE row per
   * (source, document) — the page's NEAREST chunk — BEFORE the LIMIT cut, so
   * the ANN budget returns N distinct pages (each by its closest chunk) instead
   * of N chunks that collapse to fewer pages downstream. This is the arm that
   * historically lacked the pooling the keyword arm always had. See hybrid.ts.
   */
  maxPool?: boolean;
  /**
   * Curation prefix boost inside the arm SQL (reference parity): rank by
   * boosted cosine similarity `(1 - dist) × factor` so a curated page's chunk
   * survives the ANN LIMIT over bulk-feed noise. Disabled by the caller for
   * temporal queries. Default OFF preserves the pure-distance ordering.
   */
  sourceBoost?: boolean;
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
  // Default hard-excludes pushed into the WHERE (see curation.ts).
  const excludeClause = buildHardExcludeClauseSql("d.source_path");
  const boostCase = opts.sourceBoost ? buildCurationBoostCaseSql("d.source_path") : null;
  params.push(limit);
  const limitParam = `$${params.length}`;
  // Per-page max-pool (opt-in): pool to the NEAREST chunk per (source, document)
  // BEFORE the LIMIT. Distance ascends (closer = better), so the inner
  // DISTINCT ON keeps the min-distance chunk per page (tiebroken by chunk_id),
  // and the outer query re-orders the pooled rows by distance. Without this the
  // ANN cut can be filled by several chunks of one page, dropping other pages'
  // best chunks before they rank.
  // With sourceBoost the ranking key flips from raw distance ASC to boosted
  // similarity `(1 - dist) × factor` DESC — same order when every factor is
  // 1.0, curated-tier shaping otherwise. Within one document the factor is
  // constant, so the max-pool inner collapse still keeps the nearest chunk.
  const sql = opts.maxPool
    ? boostCase
      ? `SELECT bpp.chunk_id FROM (
           SELECT DISTINCT ON (COALESCE(d.source_id, 'default'), c.document_id)
                  e.chunk_id AS chunk_id,
                  (1 - (e.vector <=> $1::vector)) * ${boostCase} AS sim
             FROM embeddings e
             JOIN chunks c    ON c.id = e.chunk_id
             JOIN documents d ON d.id = c.document_id
            WHERE ${vis}${sourceFilter}${filterClauses}${excludeClause}
            ORDER BY COALESCE(d.source_id, 'default'), c.document_id,
                     sim DESC, e.chunk_id COLLATE "C" ASC
         ) bpp
         ORDER BY bpp.sim DESC, bpp.chunk_id COLLATE "C" ASC
         LIMIT ${limitParam}`
      : `SELECT bpp.chunk_id FROM (
           SELECT DISTINCT ON (COALESCE(d.source_id, 'default'), c.document_id)
                  e.chunk_id AS chunk_id,
                  (e.vector <=> $1::vector) AS dist
             FROM embeddings e
             JOIN chunks c    ON c.id = e.chunk_id
             JOIN documents d ON d.id = c.document_id
            WHERE ${vis}${sourceFilter}${filterClauses}${excludeClause}
            ORDER BY COALESCE(d.source_id, 'default'), c.document_id,
                     dist ASC, e.chunk_id COLLATE "C" ASC
         ) bpp
         ORDER BY bpp.dist ASC, bpp.chunk_id COLLATE "C" ASC
         LIMIT ${limitParam}`
    : boostCase
      ? `SELECT e.chunk_id FROM embeddings e
         JOIN chunks c     ON c.id = e.chunk_id
         JOIN documents d  ON d.id = c.document_id
         WHERE ${vis}${sourceFilter}${filterClauses}${excludeClause}
         ORDER BY (1 - (e.vector <=> $1::vector)) * ${boostCase} DESC, e.chunk_id COLLATE "C" ASC
         LIMIT ${limitParam}`
      : `SELECT e.chunk_id FROM embeddings e
       JOIN chunks c     ON c.id = e.chunk_id
       JOIN documents d  ON d.id = c.document_id
       WHERE ${vis}${sourceFilter}${filterClauses}${excludeClause}
       ORDER BY e.vector <=> $1::vector
       LIMIT ${limitParam}`;
  const r = await engine.query<{ chunk_id: string }>(sql, params);
  return r.rows.map((row) => row.chunk_id);
}
