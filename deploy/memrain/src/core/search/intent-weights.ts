/**
 * Intent-weighted RRF tuning + exact-match boost.
 *
 * The hybrid pipeline fuses a vector list and one or more keyword lists
 * with Reciprocal Rank Fusion. Equal weighting is a fine default, but the
 * classified query intent tells us which signal to trust more:
 *
 *   - `exact`    — quoted / fragment lookups: keyword is authoritative,
 *                  embeddings blur exact tokens. Lean keyword.
 *   - `factual`  — "when did X", named-thing lookups: keyword catches the
 *                  proper noun; vector still helps. Lean keyword slightly.
 *   - `howto`    — procedural: balanced.
 *   - `topic`    — broad recall ("everything about Y"): embeddings surface
 *                  semantically-related chunks keyword misses. Lean vector.
 *   - `personal` — diary/journal recall: paraphrase-heavy, lean vector.
 *
 * Magnitudes are deliberately conservative (max 1.25 nudge): the point isn't
 * to flip rankings, it's to break ties in favor of the user's plausible intent.
 * The weight is applied as an effective RRF k (k / weight) inside rrf.ts — a
 * heavier list gets a LOWER k, so its top ranks contribute more.
 *
 * The exact-match boost multiplies a hit whose slug / kebab-slug / title
 * exactly equals the query — the entity-query signal ("the user knows the
 * name; the page named that wins the tie").
 */
import type { Intent } from "./intent.ts";
import type { QueryTaxonomy } from "./query-intent.ts";

export interface RrfIntentWeights {
  /** Multiplier for the vector (embedding) retrieval list. */
  vector: number;
  /** Multiplier for each keyword (FTS) retrieval list. */
  keyword: number;
}

const WEIGHTS: Record<Intent, RrfIntentWeights> = {
  exact: { vector: 0.95, keyword: 1.2 },
  factual: { vector: 1.0, keyword: 1.15 },
  howto: { vector: 1.0, keyword: 1.0 },
  topic: { vector: 1.1, keyword: 1.0 },
  personal: { vector: 1.1, keyword: 0.95 },
};

/** Vector/keyword RRF weights for a classified intent. */
export function intentRrfWeights(intent: Intent): RrfIntentWeights {
  return WEIGHTS[intent] ?? { vector: 1, keyword: 1 };
}

/**
 * Build the per-list weights array RRF expects, aligned to the hybrid
 * pipeline's list order: `[vector, keyword, ...keywordExpansions]`.
 * `keywordLists` is the total number of keyword lists (primary + each
 * expansion variant), so every keyword pass gets the keyword weight.
 */
export function rrfWeightsForLists(
  intent: Intent,
  keywordLists: number,
): number[] {
  const w = intentRrfWeights(intent);
  return [w.vector, ...Array.from<number>({ length: keywordLists }).fill(w.keyword)];
}

/**
 * Exact slug/title match boost per query taxonomy:
 * entity ×1.25 (the user typed the thing's name), event ×1.10, else neutral.
 */
export function exactMatchBoostForTaxonomy(taxonomy: QueryTaxonomy): number {
  switch (taxonomy) {
    case "entity":
      return 1.25;
    case "event":
      return 1.1;
    default:
      return 1.0;
  }
}

export interface ExactMatchCandidate {
  /** Page-slug forms derived from the hit's source path (see page-slug.ts). */
  slugs: readonly string[];
  title: string | null | undefined;
}

/**
 * Find the candidates the exact-match boost fires on: slug equals the
 * (lowercased) query or its kebab form (or ends with `/<kebab>`), or the
 * title equals the query. The caller multiplies the winners' scores and
 * stamps explain attribution.
 */
export function exactMatchIndices(
  candidates: readonly ExactMatchCandidate[],
  query: string,
): Set<number> {
  const touched = new Set<number>();
  const q = query.toLowerCase().trim();
  if (!q) return touched;
  const qKebab = q.replace(/\s+/g, "-");
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]!;
    const title = (c.title ?? "").toLowerCase().trim();
    const slugHit = c.slugs.some((raw) => {
      const slug = raw.toLowerCase();
      return slug === q || slug === qKebab || slug.endsWith(`/${qKebab}`);
    });
    if (slugHit || (title.length > 0 && title === q)) {
      touched.add(i);
    }
  }
  return touched;
}
