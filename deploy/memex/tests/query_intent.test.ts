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

  it("travels on the suggestion object the search path already computes", () => {
    expect(classifyQuerySuggestions("what are the different options").conceptShaped).toBe(true);
    expect(classifyQuerySuggestions("acme renewal date").conceptShaped).toBe(false);
  });
});
