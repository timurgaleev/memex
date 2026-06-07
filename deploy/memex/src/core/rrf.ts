/**
 * Reciprocal Rank Fusion — combines two ranked result lists into one.
 *
 * Score formula: sum over each list of 1 / (k + rank), where rank starts
 * at 1 for the top result. The constant k smooths the contribution of
 * lower-ranked items; 60 is the value used in the original Cormack et al.
 * (2009) paper and is a sane default here.
 *
 * Inputs are arrays of opaque IDs (chunk_id strings in our case). Output
 * is a single ranked list of IDs with their fused score, sorted desc.
 */

export interface RrfOptions {
  /** Smoothing constant. Higher = lower-ranked items contribute more. */
  k?: number;
  /**
   * Per-list multiplier, parallel to `lists`. A list's rank contributions
   * are scaled by its weight, so a heavier list pulls its items up the
   * fused ranking. Missing entries (or no `weights` at all) default to 1,
   * which reproduces the classic equal-weight RRF.
   */
  weights?: readonly number[];
}

export interface RrfResult {
  id: string;
  score: number;
}

export function reciprocalRankFusion(
  lists: ReadonlyArray<readonly string[]>,
  opts: RrfOptions = {},
): RrfResult[] {
  const k = opts.k ?? 60;
  const acc = new Map<string, number>();

  for (let li = 0; li < lists.length; li++) {
    const list = lists[li]!;
    const weight = opts.weights?.[li] ?? 1;
    for (let i = 0; i < list.length; i++) {
      const id = list[i];
      if (!id) continue;
      const rank = i + 1; // ranks are 1-based in the formula
      const contribution = weight * (1 / (k + rank));
      acc.set(id, (acc.get(id) ?? 0) + contribution);
    }
  }

  return [...acc.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}
