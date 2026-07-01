/**
 * Thin shared Bedrock Claude Haiku call helper.
 *
 * memex already calls the utility LLM in two places (search/intent.ts,
 * search/expansion.ts), but each instantiates its own BedrockRuntimeClient +
 * hand-rolls the ConverseCommand. The synthesis subsystem (Wave 5) adds five
 * more LLM call sites, so this consolidates the single "send a system+user
 * prompt, get text back" shape into one place. The existing two callers are NOT
 * migrated here (surgical-change rule); they keep their own clients.
 *
 * Design:
 *   - One reused client per region (same lazy-singleton pattern as intent.ts).
 *   - `LlmFn` is the injectable seam every synthesis phase accepts so tests run
 *     hermetically with a fake — NO live Bedrock in tests, mirroring how
 *     intent/expansion expose their model behind a default that tests bypass.
 *   - Fail-open is the CALLER's job: this helper throws on a Bedrock error; the
 *     phase wraps it in try/catch so one bad call skips, never corrupts.
 */
import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";

/** Default utility model — Claude Haiku (Bedrock), identical to intent.ts / expansion.ts. */
export const DEFAULT_HAIKU_MODEL = "eu.anthropic.claude-haiku-4-5-20251001-v1:0";

export interface LlmCallInput {
  /** System prompt — the instruction. */
  system: string;
  /** User turn — the (untrusted) content. */
  user: string;
  /** Hard cap on output tokens. Required — synthesis callers size this per phase. */
  maxTokens: number;
  /** Sampling temperature. Default 0 (deterministic-as-possible). */
  temperature?: number;
}

export interface LlmCallResult {
  /** The model's text output (already trimmed of the envelope, not of content). */
  text: string;
  /** Resolved model id used for the call — recorded as provenance on synthesis rows. */
  modelId: string;
}

/**
 * The injectable LLM seam. Production wires `callHaiku`; tests pass a fake that
 * returns canned text without any network call. Every synthesis phase takes one
 * of these as `opts.llmFn`.
 */
export type LlmFn = (input: LlmCallInput) => Promise<LlmCallResult>;

// Keyed by region: a process may call the utility LLM in more than one region,
// and a bare singleton would pin every later call to whichever region happened
// first.
const _clients = new Map<string, BedrockRuntimeClient>();
function client(region: string): BedrockRuntimeClient {
  let c = _clients.get(region);
  if (!c) {
    c = new BedrockRuntimeClient({ region });
    _clients.set(region, c);
  }
  return c;
}

export interface LlmCallOptions {
  modelId?: string;
  region?: string;
}

/**
 * Production utility-LLM call (Claude Haiku via Bedrock). Throws on any Bedrock
 * / network error — callers decide whether to fail-open. The returned `modelId`
 * is the resolved id (so a row's provenance reflects what actually ran, not a
 * guess).
 */
export async function callHaiku(
  input: LlmCallInput,
  opts: LlmCallOptions = {},
): Promise<LlmCallResult> {
  const region = opts.region ?? process.env.AWS_REGION ?? "eu-west-1";
  const modelId = opts.modelId ?? process.env.MEMEX_UTILITY_MODEL ?? DEFAULT_HAIKU_MODEL;
  const c = client(region);
  const resp = await c.send(
    new ConverseCommand({
      modelId,
      system: [{ text: input.system }],
      messages: [{ role: "user", content: [{ text: input.user }] }],
      inferenceConfig: {
        maxTokens: input.maxTokens,
        temperature: input.temperature ?? 0,
      },
    }),
  );
  const text = resp.output?.message?.content?.[0]?.text ?? "";
  return { text, modelId };
}

/**
 * Resolve the LlmFn a phase should use: the injected one (tests), else a
 * production closure over `callHaiku`. Keeps every phase's resolution identical.
 */
export function resolveLlmFn(injected: LlmFn | undefined, opts: LlmCallOptions = {}): LlmFn {
  return injected ?? ((input) => callHaiku(input, opts));
}
