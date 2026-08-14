/**
 * Zero-LLM query classifier — a regex taxonomy over the query.
 *
 * One regex pass over the query yields:
 *   - taxonomy:          'entity' | 'temporal' | 'event' | 'general'
 *   - suggestedDetail:   entity→low, temporal/event→high (temporal queries
 *                        bypass the source-prefix boost — see curation.ts)
 *   - suggestedSalience: 'off' | 'on'      — mattering (pages.salience) boost
 *   - suggestedRecency:  'off' | 'on' | 'strong' — hyperbolic recency boost
 *   - suggestedModality: 'text' | 'image'  — computed but memex has no image
 *                        arm today, so it is advisory only
 *
 * Canonical/definitional phrasings force salience + recency to 'off' UNLESS an
 * explicit temporal bound is present ("who is X today" → recency 'on').
 *
 * Pure module: no DB, no LLM, no async. This replaces the paid Haiku intent
 * call on the search hot path (see intent.ts) — the default classifier, with
 * the LLM reserved for opt-in escalation.
 */

export type QueryTaxonomy = "entity" | "temporal" | "event" | "general";
export type SalienceMode = "off" | "on";
export type RecencyMode = "off" | "on" | "strong";
export type ModalityMode = "text" | "image";

export interface QuerySuggestions {
  taxonomy: QueryTaxonomy;
  /** entity→low, temporal/event→high, general→undefined. */
  suggestedDetail: "low" | "medium" | "high" | undefined;
  suggestedSalience: SalienceMode;
  suggestedRecency: RecencyMode;
  suggestedModality: ModalityMode;
  /**
   * The question asks for a SET or a landscape ("all the companies that…",
   * "what are the different approaches to…") rather than a specific fact.
   * `search` answers those with a plausible non-empty list that the caller has
   * no way to tell is incomplete — the honest answer needs expansion.
   */
  conceptShaped: boolean;
}

const TEMPORAL_PATTERNS = [
  /\bwhen\b/i,
  /\blast\s+(met|meeting|call|conversation|chat|talked|spoke|seen|heard|time)\b/i,
  /\brecent(ly)?\b/i,
  /\bhistory\b/i,
  /\btimeline\b/i,
  /\bmeeting\s+notes?\b/i,
  /\bwhat('s| is| was)\s+new\b/i,
  /\blatest\b/i,
  /\bupdate(s)?\s+(on|from|about)\b/i,
  /\bhow\s+long\s+(ago|since)\b/i,
  // The `i` is redundant today (digits and separators only) but every sibling
  // in this list carries it; dropping it here is a trap for whoever adds a
  // letter to the pattern.
  // eslint-disable-next-line regexp/no-useless-flag
  /\b\d{4}[-/]\d{2}\b/i,
  /\blast\s+(week|month|quarter|year)\b/i,
];

/**
 * Set-shaped / landscape phrasings. Deliberately narrow: a false positive here
 * costs the caller a nudge they did not need, but a bank this small only fires
 * on questions that genuinely ask to enumerate or compare.
 *
 * Two cues used to overlap ENTITY_PATTERNS below, so one query came back as a
 * 'low'-detail entity lookup AND as "the answer may be a partial set" — a
 * wasted second tool call plus unfounded doubt about a complete answer:
 *   - "overview of" is dropped outright. "overview of Acme Corp" names one
 *     thing, and both ENTITY_PATTERNS and CANONICAL_PATTERNS already read it.
 *   - "what are the …" now needs an enumerating qualifier. "what are the
 *     deployment steps" is a lookup; "what are the different approaches to
 *     chunking" is a landscape question.
 * The collision is fixed cue-side rather than by suppressing on
 * taxonomy==='entity': ENTITY_PATTERNS matches /what (is|does|are)/, which
 * would silence our own documented true positives too.
 */
const CONCEPT_CUE_PATTERNS = [
  /\ball\s+(the\s+)?(companies|people|projects|tools|papers|notes|places|options|ways|reasons|examples)\b/i,
  /\b(list|enumerate)\s+(all|every|the)\b/i,
  /\bwhat\s+are\s+(all\b|the\s+(different|various|main|possible|available|other|kinds|types|options|approaches|ways)\b)/i,
  /\bwhich\s+(ones|of\s+(them|these|those))\b/i,
  /\bdifferent\s+(kinds|types|approaches|ways|options)\b/i,
  /\bthe\s+landscape\s+of\b/i,
  // "compare" needs two operands. Bare "compare the deploy script" names one
  // thing; a pair is spelled either as "A vs/and/with B" or as a counted set
  // ("compare the two rerankers").
  /\bcompare\b[^.?!]*?\s(vs\.?|versus|and|with|against|to)\s+\S/i,
  /\bcompare\s+(the\s+)?(two|three|four|both|several|these|those)\b/i,
  /\bevery\s+(company|person|project|note|tool)\b/i,
  /\bwho\s+all\b/i,
];

/**
 * Exact-identifier anti-signals. A quoted phrase or a kebab/snake slug means
 * the caller named the thing they want ("compare memex-search vs query") — a
 * lookup, not a survey — so the partial-set nudge is noise.
 */
const EXACT_IDENTIFIER_PATTERNS = [
  /"[^"]{2,}"/,
  /“[^”]{2,}”/,
  /\b[a-z0-9]+(?:[-_][a-z0-9]+)+\b/i,
];

/**
 * Under this a query is a bare token or a proper-noun lookup ("Acme Corp") —
 * never a question about a set, whatever cue word it happens to carry.
 */
const MIN_CONCEPT_WORDS = 3;

function wordCount(query: string): number {
  return query.split(/\s+/).filter((w) => /\w/.test(w)).length;
}

/**
 * True when the query asks for a set rather than a fact. Pure and free — no
 * DB, no model. Suppressors run before the cue bank: length and exact
 * identifiers say what the caller wants regardless of which cue matched.
 */
export function looksConceptShaped(query: string): boolean {
  if (wordCount(query) < MIN_CONCEPT_WORDS) return false;
  if (matches(EXACT_IDENTIFIER_PATTERNS, query)) return false;
  return matches(CONCEPT_CUE_PATTERNS, query);
}

const EVENT_PATTERNS = [
  /\bannounce[ds]?(ment)?\b/i,
  /\blaunch(ed|es|ing)?\b/i,
  /\braised?\s+\$?\d/i,
  /\bfund(ing|raise)\b/i,
  /\bIPO\b/i,
  /\bacquisition\b/i,
  /\bmerge[drs]?\b/i,
  /\bnews\b/i,
  /\bhappened?\b/i,
];

const ENTITY_PATTERNS = [
  /\bwho\s+is\b/i,
  /\bwhat\s+(is|does|are)\b/i,
  /\btell\s+me\s+about\b/i,
  /\bdescribe\b/i,
  /\bsummar(y|ize)\b/i,
  /\boverview\b/i,
  /\bbackground\b/i,
  /\bprofile\b/i,
  /\bwhat\s+do\s+(i|you|we)\s+know\b/i,
];

const FULL_CONTEXT_PATTERNS = [
  /\beverything\b/i,
  /\ball\s+(about|info|information|details)\b/i,
  /\bfull\s+(history|context|picture|story|details)\b/i,
  /\bcomprehensive\b/i,
  /\bdeep\s+dive\b/i,
  /\bgive\s+me\s+everything\b/i,
];

// Canonical/definitional phrasings — same bank as recency-gate.ts, kept in
// sync by the shared tests. These force salience + recency 'off' unless an
// explicit temporal bound overrides.
const CANONICAL_PATTERNS = [
  /\bwho\s+is\b/i,
  /\bcompiled\s+truth\b/i,
  /\bwhat\s+(is|are|does|means?)\b/i,
  /\bdefin(e|ition|ing)\b/i,
  /\bexplain\s+(what|how|why)\b/i,
  /\b(history|origin|background)\s+of\b/i,
  /\bconcept\s+of\b/i,
  /\boverview\s+of\b/i,
  /\btell\s+me\s+about\b/i,
  /::|->|\.\w+\(/,
  /\b(function|class|method|module)\s+\w+/i,
  /\b(graph|traversal|backlinks?|inbound|outbound)\b/i,
];

const STRONG_RECENCY_PATTERNS = [
  /\btoday\b/i,
  /\bright\s+now\b/i,
  /\bthis\s+morning\b/i,
  /\bjust\s+now\b/i,
];

const RECENCY_ON_PATTERNS = [
  /\bwhat'?s\s+(going\s+on|happening|new|latest|up)\b/i,
  /\b(latest|recent(ly)?|currently)\b/i,
  /\b(this|last|past)\s+(week|month|few\s+days|couple\s+days)\b/i,
  /\bmeeting\s+(prep|with|for|notes?|brief)\b/i,
  /\bbefore\s+(my|the|our)\s+(meeting|call|sync|chat)\b/i,
  /\bprep(are)?\s+(for|me)\b/i,
  // At least one separator char: the `\b` after the verb already rules out a
  // zero-gap "catchup", so {0,…} could never fire on its own.
  /\bcatch(es|ing)?\b[\s\w]{1,15}\bup\b/i,
  /\bremind\s+me\s+(what|about|of)\b/i,
  /\b(update|status|progress)\s+(on|with|from)\b/i,
];

const EXPLICIT_TEMPORAL_BOUND_PATTERNS = [
  /\btoday\b/i,
  /\bright\s+now\b/i,
  /\bthis\s+morning\b/i,
  /\bthis\s+week\b/i,
  /\bsince\s+(launch|last|the|\d)/i,
  /\blast\s+\d+\s+(day|days|week|weeks|month|months)\b/i,
];

const SALIENCE_ON_PATTERNS = [
  /\bwhat'?s\s+(going\s+on|happening|been\s+going|been\s+up)\b/i,
  /\bcatch(es|ing)?\b[\s\w]{1,15}\bup\b/i,
  /\bremind\s+me\s+(what|about|of)\b/i,
  /\bprep(are)?\s+(for|me)\b/i,
  /\bbefore\s+(my|the|our)\s+(meeting|call|sync|chat)\b/i,
  /\bmeeting\s+(prep|with|for|brief)\b/i,
  /\b(update|status|progress)\s+(on|with|from)\b/i,
  /\bwhat\s+matters\b/i,
  /\bwhat'?s\s+important\b/i,
];

const CROSS_MODAL_PATTERNS: RegExp[] = [
  /\b(show|find|get|pull)\s+(me\s+)?(the\s+)?(photos?|images?|pictures?|pics?|screenshots?)\b/i,
  /\b(photos?|images?|pictures?|pics?|screenshots?)\s+(of|from|at|with|showing|featuring)\b/i,
  /\bwhat\s+does\s+[\w\s']{1,40}?\s+look\s+like\b/i,
  /\b(whiteboard|diagram|slide|screenshot|infographic|chart)s?\s+(of|from|about|showing)\b/i,
  /\bdiagram\s+(of|for|showing)\b/i,
  /\bvisual(s|ly)?\s+(of|from|about|showing|representation)\b/i,
];

function matches(patterns: readonly RegExp[], q: string): boolean {
  for (const re of patterns) if (re.test(q)) return true;
  return false;
}

/** Taxonomy priority: full-context/temporal > event > entity > general. */
export function classifyQueryTaxonomy(query: string): QueryTaxonomy {
  if (matches(FULL_CONTEXT_PATTERNS, query)) return "temporal";
  if (matches(TEMPORAL_PATTERNS, query)) return "temporal";
  if (matches(EVENT_PATTERNS, query)) return "event";
  if (matches(ENTITY_PATTERNS, query)) return "entity";
  return "general";
}

export function taxonomyToDetail(
  taxonomy: QueryTaxonomy,
): "low" | "medium" | "high" | undefined {
  switch (taxonomy) {
    case "entity":
      return "low";
    case "temporal":
      return "high";
    case "event":
      return "high";
    case "general":
      return undefined;
  }
}

/** Classify a query and return every axis suggestion from one regex pass. */
export function classifyQuerySuggestions(query: string): QuerySuggestions {
  const taxonomy = classifyQueryTaxonomy(query);
  const suggestedDetail = taxonomyToDetail(taxonomy);

  const hasCanonical = matches(CANONICAL_PATTERNS, query);
  const hasTemporalBound = matches(EXPLICIT_TEMPORAL_BOUND_PATTERNS, query);
  const hasStrongRecency = matches(STRONG_RECENCY_PATTERNS, query);
  const hasRecencyOn = matches(RECENCY_ON_PATTERNS, query);
  const hasSalienceOn = matches(SALIENCE_ON_PATTERNS, query);

  let suggestedRecency: RecencyMode;
  if (hasCanonical && !hasTemporalBound) {
    suggestedRecency = "off";
  } else if (hasStrongRecency) {
    suggestedRecency = "strong";
  } else if (hasRecencyOn) {
    suggestedRecency = "on";
  } else {
    suggestedRecency = "off";
  }

  let suggestedSalience: SalienceMode;
  if (hasCanonical && !hasTemporalBound) {
    suggestedSalience = "off";
  } else if (hasSalienceOn) {
    suggestedSalience = "on";
  } else {
    suggestedSalience = "off";
  }

  const suggestedModality: ModalityMode = matches(CROSS_MODAL_PATTERNS, query)
    ? "image"
    : "text";

  return {
    taxonomy,
    suggestedDetail,
    suggestedSalience,
    suggestedRecency,
    suggestedModality,
    conceptShaped: looksConceptShaped(query),
  };
}
