/**
 * return-policy.ts — intent-aware adaptive return-sizing.
 *
 * Opt-in retrieval feature: instead of returning the full top-K candidate list
 * (noisy), return a tight set sized by query intent. Single-answer-ish queries
 * get a small cap; broad/enumeration queries get a larger one. An at-least-
 * `minKeep` failsafe guarantees a caller never gets a silent blank when
 * candidates exist.
 *
 * WHY a cap and NOT a score-cliff cut: memex's hybrid score is RRF-fused
 * (rank-based, mechanical decay), so there is no trustworthy score separatrix to
 * cut on — the same reason the score-cliff autocut was rejected. The win is
 * simply "return a tight set"; intent is the (coarse) prior on how many answers
 * the query wants. The mechanism is a cap.
 *
 * Adaptation note: the reference keys this off its own intent union
 * (entity/temporal/event/general). memex's `Intent` is
 * factual|topic|howto|personal|exact, so the mapping is adapted, NOT ported:
 * the single-answer-ish intents (`factual`, `exact`) get the tight cap;
 * everything else gets the recall-preserving cap.
 *
 * Default OFF — no behavior change for existing callers. Cache-safe by
 * construction: the cap is applied as the FINAL view on the returned list,
 * AFTER the query cache has already stored the full ranked set, so an
 * adaptive-on call never poisons a later adaptive-off lookup (and the cache key
 * needs no new component). Pure + dependency-light so it unit-tests in
 * isolation.
 */

import type { Intent } from "./intent.ts";

/**
 * Intents that want a single (or very few) answers → the tight cap. `howto`
 * is deliberately NOT here: a how-to often spans multiple chunks (steps), so it
 * stays in the recall-preserving wide bucket. Callers that know better override
 * the caps per-call.
 */
const SINGLE_ANSWER_INTENTS: ReadonlySet<Intent> = new Set<Intent>(["factual", "exact"]);

export interface AdaptiveReturnConfig {
  /** Master switch. Default false — no behavior change for existing callers. */
  enabled: boolean;
  /** Cap for single-answer-ish (`factual` / `exact`) intent. */
  entityMax: number;
  /** Cap for the broad / enumeration intents (recall-preserving). */
  otherMax: number;
  /** Failsafe: never return fewer than this when candidates exist (≥1). */
  minKeep: number;
}

/**
 * Recall-preserving defaults (product posture, not benchmark-maxing). entity=2
 * keeps the dominant answer + one hedge; other=6 trims the long noisy tail while
 * keeping enumeration recall high. Precision-sensitive callers tune these down
 * (entityMax=1, otherMax=1 ≈ "return only the top result").
 */
export const DEFAULT_ADAPTIVE_RETURN: AdaptiveReturnConfig = Object.freeze({
  enabled: false,
  entityMax: 2,
  otherMax: 6,
  minKeep: 1,
});

export interface AdaptiveReturnDecision {
  applied: boolean;
  intent: Intent;
  cap: number;
  kept: number;
  total: number;
}

/** Per-call SearchOptions shape: `true`/`false` toggle, or a partial override. */
export type AdaptiveReturnInput = boolean | Partial<AdaptiveReturnConfig> | undefined;

function clampInt(v: unknown, fallback: number, min: number): number {
  const n = typeof v === "number" ? Math.floor(v) : Number.NaN;
  return Number.isFinite(n) && n >= min ? n : fallback;
}

/** Merge defaults → per-call input into a concrete, validated config. */
export function resolveAdaptiveReturn(perCall: AdaptiveReturnInput): AdaptiveReturnConfig {
  const base = DEFAULT_ADAPTIVE_RETURN;
  if (perCall === undefined) return { ...base };
  if (perCall === true) return { ...base, enabled: true };
  if (perCall === false) return { ...base, enabled: false };
  return {
    enabled: perCall.enabled ?? base.enabled,
    entityMax: clampInt(perCall.entityMax, base.entityMax, 1),
    otherMax: clampInt(perCall.otherMax, base.otherMax, 1),
    minKeep: clampInt(perCall.minKeep, base.minKeep, 1),
  };
}

/**
 * Trim a ranked result list to the intent-driven cap. Input MUST already be in
 * final ranked order. Returns the kept prefix + a decision record. Never returns
 * empty when `results` is non-empty (the at-least-minKeep failsafe).
 */
export function applyAdaptiveReturn<T>(
  results: T[],
  intent: Intent,
  cfg: AdaptiveReturnConfig,
): { kept: T[]; decision: AdaptiveReturnDecision } {
  if (!cfg.enabled || results.length === 0) {
    return {
      kept: results,
      decision: {
        applied: false,
        intent,
        cap: results.length,
        kept: results.length,
        total: results.length,
      },
    };
  }
  const cap = SINGLE_ANSWER_INTENTS.has(intent) ? cfg.entityMax : cfg.otherMax;
  const minKeep = Math.max(1, cfg.minKeep);
  const keep = Math.max(minKeep, Math.min(cap, results.length));
  const kept = results.slice(0, keep);
  return {
    kept,
    decision: { applied: true, intent, cap, kept: kept.length, total: results.length },
  };
}
