/**
 * Query expansion — Nova Lite generates 2-3 synonym/paraphrase variants.
 *
 * The intent here is NOT to bloat the query but to give the keyword path
 * a wider recall surface. Vector search is already semantic; keyword
 * search is literal so synonyms help. hybrid uses one of:
 *   - empty array (skip — for `exact` intent)
 *   - 2-3 variants joined by OR for plainto_tsquery (Postgres adds the
 *     OR; PGLite doesn't support OR in plainto_tsquery so we run multiple
 *     queries and union the chunk_id sets).
 *
 * Cost: each call ≈ 60-120 output tokens × Nova Lite price. Negligible.
 */
import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";

const DEFAULT_MODEL = "global.amazon.nova-2-lite-v1:0";

let _client: BedrockRuntimeClient | null = null;
function client(region: string): BedrockRuntimeClient {
  if (!_client) _client = new BedrockRuntimeClient({ region });
  return _client;
}

export interface ExpandOptions {
  modelId?: string;
  region?: string;
  /** Max variants to return. Default 3. */
  max?: number;
}

const SYSTEM_PROMPT = `You are a search query expander. Given the user's query, output up to N short paraphrases or near-synonym queries, ONE PER LINE, no numbering, no commentary. Return only paraphrases that materially change the wording (different verbs, different nouns); skip empty trivial restatements.`;

export async function expandQuery(
  query: string,
  opts: ExpandOptions = {},
): Promise<string[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const max = opts.max ?? 3;

  const region = opts.region ?? process.env.AWS_REGION ?? "eu-west-1";
  const modelId = opts.modelId ?? DEFAULT_MODEL;
  const c = client(region);
  try {
    const resp = await c.send(
      new ConverseCommand({
        modelId,
        system: [{ text: SYSTEM_PROMPT.replace("N", String(max)) }],
        messages: [{ role: "user", content: [{ text: trimmed }] }],
        inferenceConfig: { maxTokens: 120, temperature: 0.3 },
      }),
    );
    const text = resp.output?.message?.content?.[0]?.text ?? "";
    const lines = text
      .split(/\r?\n/)
      .map((l) => l.replace(/^[-*•\d.\s]+/, "").trim())
      .filter((l) => l.length > 0 && l.toLowerCase() !== trimmed.toLowerCase());
    return Array.from(new Set(lines)).slice(0, max);
  } catch {
    return [];
  }
}
