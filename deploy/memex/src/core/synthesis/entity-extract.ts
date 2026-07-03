/**
 * Candidate-entity extraction for think's trajectory routing.
 *
 * Pure (no engine access): derives entity candidates from a question + the
 * slugs retrieval returned, so `think` can auto-inject a <trajectory> block for
 * "when did X change" questions without the caller naming the anchor. Two
 * sources, in priority order:
 *
 *   1. Retrieved slugs that look like entity pages (`people/`, `companies/`,
 *      `organizations/`). High precision — the brain already has them.
 *   2. Noun-phrase extraction from the question text (stop-word bounded,
 *      leading-verb stripped). Medium precision — downstream slug resolution
 *      drops anything that only resolves via the slugify fallback.
 *
 * Capped at 5 candidates so the extra trajectory calls don't dilute the prompt.
 * Adapted from the reference implementation (same tokenizer + stop-word set).
 */

// Single-word tokenizer: letters, hyphens, apostrophes (length 1-40). The
// caller stitches consecutive non-stop-word tokens into phrases so
// "Blue Bottle" stays together while "I last meet Marco" splits at boundaries.
const WORD_RX = /\b[a-zA-Z][a-zA-Z\-']{0,40}\b/g;

// Entity-prefix paths the brain uses for canonical entity pages. A retrieved
// slug starting with one of these is a high-precision candidate.
const ENTITY_PREFIXES = [
  "people/",
  "companies/",
  "organizations/",
  "orgs/",
  "deals/",
] as const;

const STOP_WORDS = new Set([
  "a", "an", "the", "i", "you", "he", "she", "we", "they", "it", "me",
  "us", "them", "my", "your", "his", "her", "our", "their", "this",
  "that", "these", "those",
  "is", "am", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "doing",
  "can", "could", "will", "would", "should", "may", "might", "must",
  "what", "when", "where", "who", "whom", "whose", "why", "how", "which",
  "of", "in", "on", "at", "to", "from", "with", "without", "by",
  "for", "about", "against", "between", "through", "during",
  "before", "after", "above", "below", "and", "or", "but", "nor",
  "so", "yet", "because", "if", "as", "than", "into", "onto",
  "time", "date", "day", "week", "month", "year", "today", "yesterday",
  "tomorrow", "now", "then", "ago", "since", "until", "long",
  "thing", "things", "something", "anything", "nothing", "one", "ones",
  "kind", "sort", "type", "lot", "lots",
  "last", "first", "next", "previous", "recent", "latest", "current",
  "still", "just", "also", "only", "such", "much", "many", "most",
  "more", "less", "few", "some", "any", "all", "no", "not", "each",
  "every", "both", "either", "neither", "same", "different", "other",
  "others", "another",
  "said", "say", "says", "told", "tell", "tells", "asked", "ask",
  "know", "knew", "known", "think", "thought",
  "changed", "switched", "moved", "updated",
  "good", "bad", "better", "worse", "best", "worst",
  "new", "old", "big", "small", "high", "low",
]);

export interface EntityCandidate {
  /** Raw candidate: a canonical slug (retrieved) or a lowercase phrase (extracted). */
  raw: string;
  origin: "retrieved" | "extracted";
}

const MAX_CANDIDATES = 5;

/**
 * Extract candidate entities from a question + retrieval-result slugs.
 * Deterministic order: retrieved-slug candidates first (input order, deduped),
 * then noun-phrase candidates. Capped at MAX_CANDIDATES. Pure — the caller
 * resolves each to a slug and applies the fallback-slugify gate.
 */
export function extractCandidateEntities(
  question: string,
  retrievedSlugs: ReadonlyArray<string>,
): EntityCandidate[] {
  const out: EntityCandidate[] = [];
  const seen = new Set<string>();

  for (const slug of retrievedSlugs) {
    if (out.length >= MAX_CANDIDATES) break;
    if (typeof slug !== "string") continue;
    const lower = slug.toLowerCase();
    if (!ENTITY_PREFIXES.some((p) => lower.startsWith(p))) continue;
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push({ raw: slug, origin: "retrieved" });
  }

  if (out.length < MAX_CANDIDATES && typeof question === "string") {
    const tokens = (question.match(WORD_RX) ?? []).map((t) => t.toLowerCase());
    const phrases: string[] = [];
    let current: string[] = [];
    const flush = () => {
      if (current.length > 0) {
        const joined = current.join(" ");
        if (joined.length >= 2 && joined.length <= 40) phrases.push(joined);
      }
      current = [];
    };
    for (const tok of tokens) {
      if (STOP_WORDS.has(tok)) flush();
      else current.push(tok);
    }
    flush();
    for (const phrase of phrases) {
      if (out.length >= MAX_CANDIDATES) break;
      const core = stripLeadingVerb(phrase);
      if (core.length < 2) continue;
      if (seen.has(core)) continue;
      seen.add(core);
      out.push({ raw: core, origin: "extracted" });
    }
  }

  return out;
}

const LEADING_VERBS = new Set([
  "meet", "met", "saw", "see", "seen", "visit", "visited",
  "spoke", "speak", "spoken", "talked", "talk", "called", "call", "wrote", "write",
  "got", "get", "gotten", "bought", "buy", "received", "sold",
  "pinged", "emailed", "texted", "reached",
]);

/** Strip a common leading verb from a multi-word phrase ("meet marco" → "marco"). */
function stripLeadingVerb(phrase: string): string {
  const words = phrase.split(/\s+/);
  if (words.length < 2) return phrase;
  if (!LEADING_VERBS.has(words[0]!)) return phrase;
  return words.slice(1).join(" ");
}
