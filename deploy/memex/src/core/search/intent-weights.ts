/**
 * Intent-weighted RRF tuning.
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
 * Weights are deliberately gentle multipliers (~0.7–1.4), a nudge on top
 * of RRF rather than a hard override — RRF's rank smoothing still
 * dominates. Tune here; nothing else needs to change.
 */
import type { Intent } from "./intent.ts";

export interface RrfIntentWeights {
  /** Multiplier for the vector (embedding) retrieval list. */
  vector: number;
  /** Multiplier for each keyword (FTS) retrieval list. */
  keyword: number;
}

const WEIGHTS: Record<Intent, RrfIntentWeights> = {
  exact: { vector: 0.7, keyword: 1.4 },
  factual: { vector: 1.0, keyword: 1.2 },
  howto: { vector: 1.0, keyword: 1.0 },
  topic: { vector: 1.3, keyword: 0.9 },
  personal: { vector: 1.2, keyword: 0.9 },
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
  return [w.vector, ...Array.from({ length: keywordLists }, () => w.keyword)];
}
