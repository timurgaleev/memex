/**
 * Life-Chronicle recency lift — a pure post-fusion ranking multiplier.
 *
 * On a temporal search (the zero-LLM classifier's recency-boost mode is on or
 * strong) the projected life/events and verbatim life/diary pages ARE the "what
 * happened lately" answer, so they get a gentle multiplicative nudge. The factor
 * is neutral (×1) whenever the mode is off OR the hit is off-prefix, so a
 * non-temporal / canonical search is bit-for-bit unchanged.
 *
 * Caller-agnostic by design: this shapes ranking only. Diary hits are excluded
 * for non-operator callers at other layers; the multiplier never inspects the
 * caller.
 */
export type RecencyBoostMode = "off" | "on" | "strong";

const CHRONICLE_PREFIXES = ["life/events/", "life/diary/"];
const STRONG_FACTOR = 1.25;
const ON_FACTOR = 1.15;

/**
 * The chronicle lift for one hit. `mode` is the resolved recency-boost mode;
 * `sourcePath` is the hit's slug (a `page://` mirror is stripped so a mirror
 * chunk matches the same prefix as its page twin).
 */
export function chronicleBoostMultiplier(
  sourcePath: string | null | undefined,
  mode: RecencyBoostMode,
): number {
  if (mode === "off") return 1;
  const sp = sourcePath ?? "";
  const normalized = sp.startsWith("page://") ? sp.slice("page://".length) : sp;
  const isChronicle = CHRONICLE_PREFIXES.some((p) => normalized.startsWith(p));
  if (!isChronicle) return 1;
  return mode === "strong" ? STRONG_FACTOR : ON_FACTOR;
}
