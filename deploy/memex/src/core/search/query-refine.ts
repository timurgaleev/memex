/**
 * query-refine — a refinement search: run a primary hybrid search, then bias
 * the ranking toward a SECOND term via weighted Reciprocal Rank Fusion.
 *
 * This is `search` with a focusing lens. The primary query establishes the
 * candidate set and carries the hit payloads; the `refine` term is searched
 * independently and the two ranked chunk-id lists are fused with
 * reciprocalRankFusion (the same fuser the hybrid arms use), so a chunk that
 * ranks well for BOTH terms floats to the top. `primaryWeight` / `refineWeight`
 * tune how hard the refine term pulls.
 *
 * Deterministic — no LLM. It composes two `hybridSearch` calls (RRF over the
 * vector + keyword arms) and the pure `reciprocalRankFusion`; the opt-in
 * two-pass Haiku rerank inside hybridSearch is NOT engaged here.
 *
 * The candidate set is the PRIMARY hits only — refine narrows/reorders, it
 * never introduces a chunk the primary query did not surface (an intersect-
 * style refinement). A refine hit absent from the primary set contributes
 * nothing.
 */
import type { Storage } from "../storage.ts";
import { hybridSearch, type SearchHit, type SearchOptions } from "./hybrid.ts";
import { reciprocalRankFusion } from "../rrf.ts";

export interface QueryRefineOptions {
  /** Number of hits to return. Default 5. */
  k?: number;
  /** RRF weight applied to the primary query's ranking. Default 1. */
  primaryWeight?: number;
  /** RRF weight applied to the refine term's ranking. Default 1. */
  refineWeight?: number;
  /** Forwarded onto the underlying hybrid searches (e.g. onCapture). */
  search?: SearchOptions;
}

/**
 * Search `query`, then re-rank the result set against `refine` via weighted RRF.
 * When `refine` is empty/blank this degrades to a plain `hybridSearch(query)`.
 */
export async function queryRefine(
  storage: Storage,
  query: string,
  refine: string,
  opts: QueryRefineOptions = {},
): Promise<SearchHit[]> {
  const k = opts.k ?? 5;
  const trimmedRefine = (refine ?? "").trim();

  // Over-fetch each arm so the fusion has depth to work with before the final
  // trim to k (mirrors hybridSearch's own fanout instinct).
  const fanout = Math.max(20, k * 3);
  const baseOpts: SearchOptions = { ...(opts.search ?? {}), k: fanout };

  const primary = await hybridSearch(storage, query, baseOpts);
  // No refine term → behave exactly like search, trimmed to k.
  if (trimmedRefine.length === 0) return primary.slice(0, k);

  const refined = await hybridSearch(storage, trimmedRefine, baseOpts);

  // Index the primary hits by chunkId — they own the candidate set + payloads.
  const byId = new Map<string, SearchHit>();
  for (const h of primary) byId.set(h.chunkId, h);

  const primaryIds = primary.map((h) => h.chunkId);
  // Restrict the refine list to chunks the primary query already surfaced, so
  // refinement reorders within the candidate set rather than widening it.
  const refineIds = refined
    .map((h) => h.chunkId)
    .filter((id) => byId.has(id));

  const fused = reciprocalRankFusion([primaryIds, refineIds], {
    weights: [opts.primaryWeight ?? 1, opts.refineWeight ?? 1],
  });

  const out: SearchHit[] = [];
  for (const { id, score } of fused) {
    const hit = byId.get(id);
    if (!hit) continue;
    out.push({ ...hit, score });
    if (out.length >= k) break;
  }
  return out;
}
