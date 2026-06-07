/**
 * Recency signal — a gentle post-fusion multiplier favouring freshly
 * updated content.
 *
 * Operates on the LIVE retrieval model (`documents.updated_at`); the
 * dormant `pages` model is untouched. The multiplier decays exponentially
 * with content age but never below `floor`, so old-but-relevant documents
 * are nudged down, not buried:
 *
 *   multiplier(age) = floor + (1 - floor) * 0.5^(ageDays / halfLifeDays)
 *
 *   age 0          → 1.0
 *   age halfLife   → floor + (1-floor)/2
 *   age → ∞        → floor
 *
 * A missing / unparseable / future timestamp returns 1.0 (neutral), so the
 * signal can never penalise a hit it can't date.
 */
export interface RecencyOptions {
  /** Age at which the decaying part halves. Default 120 days. */
  halfLifeDays?: number;
  /** Lower bound on the multiplier (0..1). Default 0.6. */
  floor?: number;
}

const DAY_MS = 86_400_000;

export function recencyMultiplier(
  updatedAtIso: string | null | undefined,
  nowMs: number,
  opts: RecencyOptions = {},
): number {
  const halfLifeDays = opts.halfLifeDays ?? 120;
  const floor = opts.floor ?? 0.6;
  if (!updatedAtIso) return 1;
  const t = Date.parse(updatedAtIso);
  if (Number.isNaN(t)) return 1;
  const ageDays = (nowMs - t) / DAY_MS;
  if (ageDays <= 0) return 1; // future / just-now → no penalty
  const decay = Math.pow(0.5, ageDays / halfLifeDays);
  return floor + (1 - floor) * decay;
}
