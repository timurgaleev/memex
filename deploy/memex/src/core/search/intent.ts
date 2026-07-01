/**
 * Query intent classifier — Claude Haiku (Bedrock), cheap utility tier.
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
 */
import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";

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

export async function classifyIntent(
  query: string,
  opts: ClassifyIntentOptions = {},
): Promise<Intent> {
  const trimmed = query.trim();
  if (!trimmed) return "topic";

  // Cheap heuristics first — skip Bedrock for obvious cases.
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) return "exact";
  if (/\bhow (do|to|can|should)\b/i.test(trimmed)) return "howto";
  if (/\b(when|what|who|where|which) (is|was|did)\b/i.test(trimmed)) return "factual";

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
    return "topic";
  } catch {
    // Network blip / model unavailable → safe default.
    return "topic";
  }
}
