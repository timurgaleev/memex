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
   * Per-list weight, parallel to `lists`. Applied as an effective smoothing
   * constant k/weight for THAT list: a heavier list
   * gets a LOWER k, so its top ranks contribute meaningfully more while its
   * long tail stays flat — rank-shaping rather than flat score scaling.
   * Missing entries (or no `weights` at all) default to 1, which reproduces
   * the classic equal-weight RRF. Non-positive weights are treated as 1.
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
    // Effective per-list k: k / weight. weight > 1 lowers
    // the smoothing constant → stronger top-rank contribution for that list.
    const listK = weight > 0 ? k / weight : k;
    for (let i = 0; i < list.length; i++) {
      const id = list[i];
      if (!id) continue;
      const rank = i + 1; // ranks are 1-based in the formula
      const contribution = 1 / (listK + rank);
      acc.set(id, (acc.get(id) ?? 0) + contribution);
    }
  }

  return [...acc.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}
