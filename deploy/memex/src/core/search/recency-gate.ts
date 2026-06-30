/**
 * Canonical-query gate — a pure-regex signal that a query wants the
 * authoritative / definitional answer ("who is X", "what is X", "define X",
 * "explain how Y works", a bare symbol). For these, the freshness (recency)
 * and salience post-fusion multipliers should NOT fire: an old-but-canonical
 * page is exactly what the user wants, and decaying it by age buries the right
 * hit. An explicit temporal bound ("who is X today", "this week") overrides the
 * gate — then freshness is back in play.
 *
 * Deterministic, no LLM, no Bedrock — runs once per query in the hybrid path.
 */

const CANONICAL_PATTERNS: readonly RegExp[] = [
  /\bwho\s+is\b/i,
  /\bwhat\s+(is|are|does|means?)\b/i,
  /\bdefin(e|ition|ing)\b/i,
  /\bexplain\s+(what|how|why)\b/i,
  /\b(history|origin|background)\s+of\b/i,
  /\bconcept\s+of\b/i,
  /\boverview\s+of\b/i,
  /\btell\s+me\s+about\b/i,
  // Code-shaped queries — a symbol, a qualified name, a call, a declaration.
  /::|->|\.\w+\(/,
  /\b(function|class|method|module)\s+\w+/i,
];

// An explicit temporal bound wins over canonical: the user pinned a time window,
// so freshness is wanted even on an otherwise-definitional phrasing.
const EXPLICIT_TEMPORAL_BOUND_PATTERNS: readonly RegExp[] = [
  /\btoday\b/i,
  /\bright\s+now\b/i,
  /\bthis\s+morning\b/i,
  /\bthis\s+week\b/i,
  /\bsince\s+(launch|last|the|\d)/i,
  /\blast\s+\d+\s+(day|days|week|weeks|month|months)\b/i,
  /\blast\s+(week|month|year|quarter)\b/i,
  /\b(latest|recent(ly)?|currently)\b/i,
];

function matchesAny(patterns: readonly RegExp[], query: string): boolean {
  return patterns.some((re) => re.test(query));
}

/**
 * True when the query is canonical/definitional AND carries no explicit
 * temporal bound — i.e. the recency + salience multipliers should be skipped.
 */
export function isCanonicalQuery(query: string): boolean {
  const q = query.trim();
  if (!q) return false;
  return (
    matchesAny(CANONICAL_PATTERNS, q) &&
    !matchesAny(EXPLICIT_TEMPORAL_BOUND_PATTERNS, q)
  );
}
