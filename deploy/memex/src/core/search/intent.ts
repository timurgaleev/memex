/**
 * Query intent classifier — zero-LLM regex by default (reference parity).
 *
 * Distinguishes between:
 *   - factual:    "when did X happen", "what is X"
 *   - topic:      broad-recall lookups, "everything about Y"
 *   - howto:      procedural questions, "how do I X"
 *   - personal:   diary / journal queries, "what was I working on"
 *   - exact:      exact-phrase / fragment lookups, often quoted
 *
 * Used by source-boost (factual queries lean canonical; topic queries
 * benefit from broader recall) and dedup (exact queries skip dedup —
 * user might want all matching fragments).
 *
 * The reference classifies with a pure regex taxonomy and never spends an
 * LLM call on the search hot path; memex follows. The cheap heuristics run
 * first, then the query-intent taxonomy maps onto memex's intent set
 * (entity→factual, temporal→personal, event/general→topic). The old Claude
 * Haiku fallback survives behind MEMEX_INTENT_LLM=1 for operators who want
 * the paid tie-break on unmatched queries.
 */
import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { classifyQueryTaxonomy } from "./query-intent.ts";

export type Intent = "factual" | "topic" | "howto" | "personal" | "exact";

export const VALID_INTENTS: ReadonlySet<Intent> = new Set([
  "factual",
  "topic",
  "howto",
  "personal",
  "exact",
]);

const DEFAULT_MODEL = "eu.anthropic.claude-haiku-4-5-20251001-v1:0";

let _client: BedrockRuntimeClient | null = null;
function client(region: string): BedrockRuntimeClient {
  if (!_client) _client = new BedrockRuntimeClient({ region });
  return _client;
}

export interface ClassifyIntentOptions {
  modelId?: string;
  region?: string;
}

const SYSTEM_PROMPT = `You are a search-intent classifier. Given a user query, output exactly one word from this set: factual, topic, howto, personal, exact. Output nothing else.`;

/**
 * Map the reference taxonomy onto memex's intent set. `temporal` leans
 * `personal` (diary/journal recall — the vector-leaning RRF profile the
 * reference's recency tilt approximates); `event`/`general` stay `topic`
 * (broad recall).
 */
function taxonomyToIntent(query: string): Intent {
  switch (classifyQueryTaxonomy(query)) {
    case "entity":
      return "factual";
    case "temporal":
      return "personal";
    default:
      return "topic";
  }
}

export async function classifyIntent(
  query: string,
  opts: ClassifyIntentOptions = {},
): Promise<Intent> {
  const trimmed = query.trim();
  if (!trimmed) return "topic";

  // Cheap heuristics first — obvious cases never reach the taxonomy or LLM.
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) return "exact";
  if (/\bhow (do|to|can|should)\b/i.test(trimmed)) return "howto";
  if (/\b(when|what|who|where|which) (is|was|did)\b/i.test(trimmed)) return "factual";

  // Zero-LLM default (reference parity): the regex taxonomy decides. The paid
  // Haiku call fires ONLY when the operator opted back in via MEMEX_INTENT_LLM=1.
  if (process.env.MEMEX_INTENT_LLM !== "1") {
    return taxonomyToIntent(trimmed);
  }

  const region = opts.region ?? process.env.AWS_REGION ?? "eu-west-1";
  const modelId = opts.modelId ?? DEFAULT_MODEL;
  const c = client(region);
  try {
    const resp = await c.send(
      new ConverseCommand({
        modelId,
        system: [{ text: SYSTEM_PROMPT }],
        messages: [{ role: "user", content: [{ text: trimmed }] }],
        inferenceConfig: { maxTokens: 8, temperature: 0 },
      }),
    );
    const text =
      resp.output?.message?.content?.[0]?.text?.trim().toLowerCase() ?? "";
    const word = text.split(/\s+/)[0] ?? "";
    if (VALID_INTENTS.has(word as Intent)) return word as Intent;
    return taxonomyToIntent(trimmed);
  } catch {
    // Network blip / model unavailable → the zero-LLM taxonomy still answers.
    return taxonomyToIntent(trimmed);
  }
}
