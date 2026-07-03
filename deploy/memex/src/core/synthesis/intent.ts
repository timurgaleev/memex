/**
 * Zero-latency intent classifier for `think` trajectory routing. Regex-first
 * (no LLM call) so the common "other" path adds no latency. Three buckets:
 *   - 'temporal':         "when did I last…", "how long ago…", date markers
 *   - 'knowledge_update': "X changed / switched / no longer…"
 *   - 'other':            everything else (no trajectory injection)
 *
 * Errs toward 'other': a false positive wastes prompt tokens on an irrelevant
 * trajectory block; a false negative just misses the trajectory boost on a few
 * questions. Precision over recall at this surface.
 *
 * Adapted from the reference's think intent classifier, trimmed to memex.
 */

export type Intent = "temporal" | "knowledge_update" | "other";

// Compiled once at module load.
const TEMPORAL_RX = new RegExp(
  [
    // Question-word triggers.
    "\\bwhen\\b",
    "\\bhow\\s+long\\s+ago\\b",
    "\\bhow\\s+long\\s+(have|has|did|do)\\b",
    // Recency markers.
    "\\blast\\s+(time|met|saw|spoke|visited)\\b",
    "\\b(is\\s+)?still\\b",
    "\\bcurrent(?:ly)?\\b",
    "\\bnow\\b",
    // Temporal prepositions with date-shaped context.
    "\\bbefore\\s+(I|we|the|that)\\b",
    "\\bafter\\s+(I|we|the|that)\\b",
    "\\bsince\\s+(when|I|we|the|last|\\d{4})\\b",
    // Explicit date markers.
    "\\b(20\\d{2}|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\b",
  ].join("|"),
  "i",
);

const KNOWLEDGE_UPDATE_RX = new RegExp(
  [
    // Supersession verbs — an explicit signal that something changed. Verb-stem
    // + optional inflection so "switch/switched/switches/switching" all match.
    "\\b(?:chang|switch|mov|updat)(?:e[ds]?|ed|es|ing)?\\b",
    "\\bno\\s+longer\\b",
    "\\binstead\\s+of\\b",
    "\\bused\\s+to\\b",
    "\\b(?:they|he|she|we|I)\\s+stopped\\b",
    // "what is the current/latest X".
    "\\b(current|latest|new|most\\s+recent)\\s+\\w+",
    "\\bwhat(?:'s|\\s+is)\\s+(?:the\\s+)?(?:current|latest|new)\\b",
  ].join("|"),
  "i",
);

/**
 * Classify a question into one of the three intents. Knowledge-update wins over
 * temporal when both match — supersession framing is the more specific signal
 * (every supersession question is also temporal, but the "(superseded prior)"
 * annotation is the knowledge_update differentiator).
 */
export function classifyIntent(question: string): Intent {
  if (typeof question !== "string" || question.length === 0) return "other";
  if (KNOWLEDGE_UPDATE_RX.test(question)) return "knowledge_update";
  if (TEMPORAL_RX.test(question)) return "temporal";
  return "other";
}
