/**
 * `memex search modes` — read-only view of the ACTIVE retrieval ranking
 * configuration: the resolved post-fusion ranking knobs (with their env
 * overrides + defaults) plus the intent taxonomy and the cheap-heuristic rules.
 *
 * Runs no search and touches no storage — it only resolves the same getters
 * the live search path uses, so an operator can confirm which knobs took effect
 * on the deployed brain and which `MEMEX_*` env var tunes each one. Output is
 * JSON for piping into jq.
 *
 * It also doubles as a CONFIG VALIDATOR: the knob resolvers fail LOUD on a
 * malformed `MEMEX_*` value, and `search modes` deliberately does NOT catch —
 * a bad value that would break the next real search surfaces here as a
 * non-zero exit, so an operator can validate the env before relying on it.
 */
import {
  getTitleBoost,
  DEFAULT_TITLE_BOOST,
} from "../core/search/title-match.ts";
import {
  resolveRecencyDecayMap,
  DEFAULT_RECENCY_FALLBACK,
} from "../core/search/recency.ts";
import { getNearDupThreshold } from "../core/search/dedup.ts";
import { rankingSignature } from "../core/search/query-cache.ts";
import { VALID_INTENTS } from "../core/search/intent.ts";

export interface SearchModesView {
  ok: true;
  intents: string[];
  intent_heuristics: Record<string, string>;
  knobs: Record<string, unknown>;
  ranking_signature: string;
}

/** Build the read-only modes view (pure — exported for tests). */
export function buildSearchModes(): SearchModesView {
  return {
    ok: true,
    intents: [...VALID_INTENTS],
    // The cheap pre-Bedrock heuristics from classifyIntent; anything matching
    // none of these is sent to Nova-Lite, falling back to `topic`.
    intent_heuristics: {
      exact: 'query wrapped in "double quotes"',
      howto: 'matches /\\bhow (do|to|can|should)\\b/i',
      factual: 'matches /\\b(when|what|who|where|which) (is|was|did)\\b/i',
      "(empty)": "topic",
      "(otherwise)": "Nova-Lite classify → one of the intents, else topic",
    },
    knobs: {
      title_boost: {
        value: getTitleBoost(),
        default: DEFAULT_TITLE_BOOST,
        env: "MEMEX_TITLE_BOOST",
        note: "post-fusion multiplier when the query is a contiguous title phrase; < 1.0 disables",
      },
      recency_decay: {
        map: resolveRecencyDecayMap(),
        fallback: DEFAULT_RECENCY_FALLBACK,
        env: "MEMEX_RECENCY_DECAY",
        note: "per-prefix half-life/floor (longest-prefix-match); paths matching no prefix use the fallback",
      },
      neardup_jaccard: {
        value: getNearDupThreshold(),
        env: "MEMEX_NEARDUP_JACCARD",
        note: "word-set Jaccard above which a lower-ranked near-duplicate hit is dropped; > 1.0 disables",
      },
      rerank: {
        enabled: process.env["MEMEX_RERANK"] === "1",
        env: "MEMEX_RERANK",
        default: false,
        note: "opt-in two-pass Haiku rerank",
      },
      query_cache: {
        enabled: process.env["MEMEX_QUERY_CACHE"] !== "0",
        env: "MEMEX_QUERY_CACHE",
        default: true,
        note: "exact-match cache, invalidated by the document-generation clock",
      },
    },
    // The composite key the query cache folds in — a change re-keys the cache.
    ranking_signature: rankingSignature(),
  };
}

export function runSearchModes(): void {
  console.log(JSON.stringify(buildSearchModes(), null, 2));
}
