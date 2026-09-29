/**
 * Zero-LLM query classifier (query-intent.ts) — pure regex taxonomy +
 * per-axis suggestions, no Bedrock, no DB. Also covers the intent.ts
 * mapping so the paid-Haiku hot path stays dead by default.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
  classifyQuerySuggestions,
  classifyQueryTaxonomy,
  taxonomyToDetail,
  looksConceptShaped,
} from "../src/core/search/query-intent.ts";
import { classifyIntent } from "../src/core/search/intent.ts";

const saved = process.env.MEMEX_INTENT_LLM;
afterEach(() => {
  if (saved === undefined) delete process.env.MEMEX_INTENT_LLM;
  else process.env.MEMEX_INTENT_LLM = saved;
});

describe("classifyQueryTaxonomy", () => {
  it("classifies entity queries", () => {
    expect(classifyQueryTaxonomy("who is alice")).toBe("entity");
    expect(classifyQueryTaxonomy("tell me about acme corp")).toBe("entity");
    // First person included — the operator's canonical phrasing.
    expect(classifyQueryTaxonomy("what do I know about alice")).toBe("entity");
    expect(classifyQueryTaxonomy("what do you know about acme")).toBe("entity");
  });

  it("classifies temporal queries (full-context included)", () => {
    expect(classifyQueryTaxonomy("what happened last week")).toBe("temporal");
    expect(classifyQueryTaxonomy("meeting notes from the sync")).toBe("temporal");
    expect(classifyQueryTaxonomy("give me everything about the deal")).toBe("temporal");
  });

  it("classifies event queries", () => {
    expect(classifyQueryTaxonomy("acme announced funding")).toBe("event");
    expect(classifyQueryTaxonomy("they raised $10M")).toBe("event");
  });

  it("falls back to general", () => {
    expect(classifyQueryTaxonomy("zigbee pairing")).toBe("general");
  });

  it("maps taxonomy to detail (entity low, temporal/event high)", () => {
    expect(taxonomyToDetail("entity")).toBe("low");
    expect(taxonomyToDetail("temporal")).toBe("high");
    expect(taxonomyToDetail("event")).toBe("high");
    expect(taxonomyToDetail("general")).toBeUndefined();
  });
});

describe("classifyQuerySuggestions — recency/salience axes", () => {
  it("canonical queries force recency + salience off", () => {
    const s = classifyQuerySuggestions("who is alice");
    expect(s.suggestedRecency).toBe("off");
    expect(s.suggestedSalience).toBe("off");
  });

  it("an explicit temporal bound overrides the canonical gate", () => {
    const s = classifyQuerySuggestions("who is alice today");
    expect(s.suggestedRecency).toBe("strong"); // "today" = strong recency
  });

  it("strong recency phrasings", () => {
    expect(classifyQuerySuggestions("news from today").suggestedRecency).toBe("strong");
    expect(classifyQuerySuggestions("what is on right now").suggestedRecency).toBe("strong");
  });

  it("moderate recency phrasings", () => {
    expect(classifyQuerySuggestions("catch me up on the project").suggestedRecency).toBe("on");
    expect(classifyQuerySuggestions("status on the migration").suggestedRecency).toBe("on");
  });

  it("salience fires on meeting-prep / catch-up phrasings", () => {
    expect(classifyQuerySuggestions("meeting prep for tomorrow").suggestedSalience).toBe("on");
    expect(classifyQuerySuggestions("catch me up on people stuff").suggestedSalience).toBe("on");
  });

  it("plain lookups keep both axes off and modality text", () => {
    const s = classifyQuerySuggestions("zigbee pairing setup");
    expect(s.suggestedRecency).toBe("off");
    expect(s.suggestedSalience).toBe("off");
    expect(s.suggestedModality).toBe("text");
  });

  it("visual-artifact phrasings flip modality to image", () => {
    expect(classifyQuerySuggestions("show me photos of the whiteboard").suggestedModality).toBe(
      "image",
    );
  });
});

describe("classifyIntent — zero-LLM default", () => {
  it("resolves without Bedrock and maps the taxonomy onto memex intents", async () => {
    delete process.env.MEMEX_INTENT_LLM; // default: no LLM call
    // Heuristics first.
    expect(await classifyIntent('"exact phrase"')).toBe("exact");
    expect(await classifyIntent("how do I configure this")).toBe("howto");
    expect(await classifyIntent("when was the deal signed")).toBe("factual");
    // Taxonomy mapping: entity→factual, temporal→personal, else topic.
    expect(await classifyIntent("tell me about alice")).toBe("factual");
    expect(await classifyIntent("meeting notes from monday")).toBe("personal");
    expect(await classifyIntent("zigbee pairing setup")).toBe("topic");
  });
});

describe("concept-shaped detection (steers set questions toward `query`)", () => {
  it("fires on questions that ask to enumerate or compare", () => {
    for (const q of [
      "all the companies working on retrieval",
      "what are the different approaches to chunking",
      "list every project that touched auth",
      "compare the two rerankers",
      "the landscape of vector databases",
      "which of those did we reject",
    ]) {
      expect(looksConceptShaped(q)).toBe(true);
    }
  });

  it("stays quiet on a question that names one thing", () => {
    for (const q of [
      "when did I last meet alice",
      "what is the rollback budget",
      "acme contract renewal date",
      "who founded acme",
    ]) {
      expect(looksConceptShaped(q)).toBe(false);
    }
  });

  it("needs more than a bare token or a proper-noun lookup", () => {
    // A cue word alone is not a question about a set.
    expect(looksConceptShaped("compare")).toBe(false);
    expect(looksConceptShaped("list all")).toBe(false);
    expect(looksConceptShaped("Acme Corp")).toBe(false);
    // Three words is enough once a cue is there.
    expect(looksConceptShaped("all the companies")).toBe(true);
  });

  it("stays quiet when the caller named an exact identifier", () => {
    // A quoted phrase or a slug is a lookup for that thing — the caller is not
    // asking for a landscape, so the partial-set nudge is noise.
    expect(looksConceptShaped("compare memex-search vs query")).toBe(false);
    expect(looksConceptShaped('list every note tagged "rollback budget"')).toBe(false);
    expect(looksConceptShaped("what are the different options for token_budget")).toBe(false);
    // Same question without the identifier still fires.
    expect(looksConceptShaped("compare search vs query")).toBe(true);
    expect(looksConceptShaped("list every note tagged rollback")).toBe(true);
  });

  it("does not fire on single-entity phrasings that ENTITY_PATTERNS owns", () => {
    // These used to report taxonomy 'entity' (detail 'low') AND "the answer may
    // be a partial set" at the same time — a wasted second tool call.
    for (const q of ["overview of Acme Corp", "what are the deployment steps"]) {
      expect(looksConceptShaped(q)).toBe(false);
      expect(classifyQueryTaxonomy(q)).toBe("entity");
    }
  });

  it("keeps firing on an entity-taxonomy question that really asks for a set", () => {
    // The suppressor is cue-side, not taxonomy-side: ENTITY_PATTERNS matches
    // "what are", so suppressing on taxonomy would kill this true positive.
    const s = classifyQuerySuggestions("what are the different approaches to chunking");
    expect(s.taxonomy).toBe("entity");
    expect(s.conceptShaped).toBe(true);
  });

  it("requires `compare` to carry two operands", () => {
    expect(looksConceptShaped("compare the rollback plan")).toBe(false);
    expect(looksConceptShaped("compare bm25 and vector reranking")).toBe(true);
    expect(looksConceptShaped("compare the two rerankers")).toBe(true);
  });

  it("travels on the suggestion object the search path already computes", () => {
    expect(classifyQuerySuggestions("what are the different options").conceptShaped).toBe(true);
    expect(classifyQuerySuggestions("acme renewal date").conceptShaped).toBe(false);
  });
});

/**
 * The exact-identifier suppressors must stay linear in query length.
 *
 * `/“[^”]{2,}”/` was quadratic: `“` and `”` are different characters, so the
 * class ACCEPTED `“` and a run of openers walked to the end of the query from
 * every one of the n start positions. Measured through looksConceptShaped on
 * "what are the " + "“"*n: 8 K = 29 ms, 16 K = 95 ms, 32 K = 563 ms,
 * 64 K = 2.27 s — ratio ~4.0 per doubling, extrapolating to about nine minutes
 * at 1 MB. The query is the raw `search` argument off the MCP request and
 * nothing caps its length, so that is a request thread held for minutes.
 *
 * The bound is MAX_SLUG_LEN (256): this pattern spots a thing the caller named,
 * and nothing longer than a page slug is a name. The ASCII sibling needs no
 * bound because `[^"]` already excludes its own delimiter.
 *
 * The ceiling is deliberately loose — linear is milliseconds, quadratic is
 * minutes.
 */
describe("exact-identifier suppressor cost", () => {
  it("stays linear on a 1 MB run of opening smart quotes", () => {
    // Three real words first: MIN_CONCEPT_WORDS gates the pattern bank, so a
    // bare run of quotes would never reach the scan under test.
    const query = "what are the " + "“".repeat(1_000_000);

    const started = performance.now();
    const out = looksConceptShaped(query);
    const elapsed = performance.now() - started;

    expect(out).toBe(false);
    expect(elapsed).toBeLessThan(15_000);
  });

  // The cue has to fire for the suppressor to be the thing under test: without
  // an enumerating qualifier "what are the …" is a lookup and returns false for
  // its own reasons, which would make these assertions pass on a broken bound.
  it("still suppresses a cue-matching query that carries a quoted phrase", () => {
    expect(looksConceptShaped("what are the different approaches to chunking")).toBe(true);
    expect(looksConceptShaped('what are the different approaches to “chunking”')).toBe(false);
    expect(looksConceptShaped('what are the different approaches to "chunking"')).toBe(false);
  });

  it("suppresses at the 256-char bound and stops just past it", () => {
    // The bound is not arbitrary: a page slug is capped at 256, so a longer
    // span could never be the name of a thing we hold.
    const span = (n: number) => `what are the different approaches to “${"a".repeat(n)}”`;
    expect(looksConceptShaped(span(256))).toBe(false);
    expect(looksConceptShaped(span(257))).toBe(true);
  });
});
