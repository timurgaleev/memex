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
import { visibilityClause } from "../visibility.ts";
import { chunkFilterClauses, type ChunkFilters } from "./filters.ts";
import {
  buildCurationBoostCaseSql,
  buildHardExcludeClauseSql,
} from "./curation.ts";

export interface KeywordSearchOptions {
  sourceIds?: readonly string[];
  /**
   * Pushed-down lang / symbol_kind / since / until predicates. Folded into the
   * WHERE clause so the LIMIT budget is spent on rows that already match — a
   * filtered match ranking below the fanout is no longer dropped. See filters.ts.
   */
  filters?: ChunkFilters;
  /**
   * Per-page max-pool (opt-in, default OFF): collapse the candidate set to ONE
   * row per (source, document) — the page's highest-ranking chunk — BEFORE the
   * LIMIT cut, so the budget covers N distinct pages (each by its best chunk)
   * instead of N chunks that may all belong to a few noisy pages. Deterministic
   * DISTINCT ON; the surviving chunk is fully pinned by the `score DESC, id`
   * tiebreak. See hybrid.ts (`maxPool`).
   */
  maxPool?: boolean;
  /**
   * Curation prefix boost inside the arm SQL (reference parity): multiply the
   * FTS rank by the per-prefix authority factor BEFORE the LIMIT cut, so a
   * curated page's chunk survives the fanout over bulk-feed noise. The caller
   * (hybrid.ts) disables it for temporal queries — freshness queries must not
   * be steered toward evergreen tiers. Default OFF preserves prior ordering.
   */
  sourceBoost?: boolean;
}

export async function keywordSearch(
  engine: Engine,
  query: string,
  limit: number,
  opts: KeywordSearchOptions = {},
): Promise<string[]> {
  const sourceIds = opts.sourceIds ?? [];
  const vis = visibilityClause("d");
  // Join documents so the visibility filter (deleted/archived/quarantine)
  // applies — soft-deleted/quarantined docs must never be candidates.
  const params: unknown[] = [query];
  let sourceFilter = "";
  if (sourceIds.length > 0) {
    params.push(sourceIds);
    sourceFilter = ` AND d.source_id = ANY($${params.length}::text[])`;
  }
  const filterClauses = chunkFilterClauses(params, opts.filters);
  // Default hard-excludes (test fixtures / attachments / raw sidecars) are
  // pushed into the WHERE so noise never consumes LIMIT budget.
  const excludeClause = buildHardExcludeClauseSql("d.source_path");
  // Per-prefix authority factor folded into the ranking expression (LIMIT
  // shaping); '1.0' when disabled so the SQL shape stays uniform.
  const boostCase = opts.sourceBoost ? buildCurationBoostCaseSql("d.source_path") : "1.0";
  params.push(limit);
  const limitParam = `$${params.length}`;
  // Per-page max-pool (opt-in): pool the full match set to the best chunk per
  // (source, document) BEFORE the LIMIT, so a page's top chunk can't be
  // truncated out by weaker chunks of OTHER pages filling the early slots. The
  // inner DISTINCT ON leads its ORDER BY with the collapse key (required), then
  // the tiebreak `score DESC, id` pins the surviving chunk deterministically;
  // the outer query re-ranks the pooled rows by score. Same matched set + WHERE
  // as the flat path — only the per-page collapse differs.
  const sql = opts.maxPool
    ? `SELECT bpp.id FROM (
         SELECT DISTINCT ON (COALESCE(d.source_id, 'default'), c.document_id)
                c.id AS id,
                ts_rank_cd(c.search_vector, plainto_tsquery('simple', $1)) * ${boostCase} AS score
           FROM chunks c
           JOIN documents d ON d.id = c.document_id
          WHERE c.search_vector @@ plainto_tsquery('simple', $1)
            AND ${vis}${sourceFilter}${filterClauses}${excludeClause}
          ORDER BY COALESCE(d.source_id, 'default'), c.document_id,
                   score DESC, c.id COLLATE "C" ASC
       ) bpp
       ORDER BY bpp.score DESC, bpp.id COLLATE "C" ASC
       LIMIT ${limitParam}`
    : `SELECT c.id FROM chunks c
       JOIN documents d ON d.id = c.document_id
       WHERE c.search_vector @@ plainto_tsquery('simple', $1)
         AND ${vis}${sourceFilter}${filterClauses}${excludeClause}
       ORDER BY ts_rank_cd(c.search_vector, plainto_tsquery('simple', $1)) * ${boostCase} DESC, c.id COLLATE "C" ASC
       LIMIT ${limitParam}`;
  const r = await engine.query<{ id: string }>(sql, params);
  return r.rows.map((row) => row.id);
}
