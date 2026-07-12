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
  ValidationException,
  type ContentBlock,
} from "@aws-sdk/client-bedrock-runtime";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { resolveModel } from "./resolve-model.ts";
import { awsRegion, llmRequestTimeoutMs, withInflightCap } from "./gateway.ts";

/** Default utility model — Claude Haiku (Bedrock), identical to intent.ts / expansion.ts. */
export const DEFAULT_HAIKU_MODEL = "eu.anthropic.claude-haiku-4-5-20251001-v1:0";

export interface LlmUsage {
  /** Non-cached input tokens billed at the normal input rate. */
  inputTokens: number;
  outputTokens: number;
  /** Tokens served from the prompt cache — billed at ~10% of the input rate. */
  cacheReadInputTokens?: number;
  /** Tokens written to the prompt cache — billed at ~125% of the input rate. */
  cacheWriteInputTokens?: number;
}

export interface LlmCallInput {
  /** System prompt — the instruction. */
  system: string;
  /** User turn — the (untrusted) content. */
  user: string;
  /** Hard cap on output tokens. Required — synthesis callers size this per phase. */
  maxTokens: number;
  /** Sampling temperature. Default 0 (deterministic-as-possible). */
  temperature?: number;
  /**
   * Optional cacheable leading block for the USER turn. When set, it is sent as
   * its own content block followed by a Bedrock `cachePoint`, so a model/region
   * that supports prompt caching caches this prefix and reuses it across calls
   * that share the SAME prefix (e.g. one document across all of its chunks). The
   * `user` field then carries only the uncached remainder (the per-call tail).
   * Fail-safe: a model/region that rejects the `cachePoint` (ValidationException)
   * is retried once as a single uncached block, so the call still succeeds.
   */
  cachePrefix?: string;
}

export interface LlmCallResult {
  /** The model's text output (already trimmed of the envelope, not of content). */
  text: string;
  /** Resolved model id used for the call — recorded as provenance on synthesis rows. */
  modelId: string;
  /** Token usage when the transport exposes it (Bedrock Converse). Absent for a
   *  fake seam that returns none — callers then fall back to an estimate. */
  usage?: LlmUsage;
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
    c = new BedrockRuntimeClient({
      region,
      // Tuned retry/backoff/timeout — the SDK gives this natively, so memex
      // doesn't hand-roll it. Adaptive retry backs off on 429/5xx; the request
      // timeout (MEMEX_LLM_TIMEOUT_MS, default 30s) bounds a hung call.
      maxAttempts: 4,
      retryMode: "adaptive",
      requestHandler: new NodeHttpHandler({
        requestTimeout: llmRequestTimeoutMs(),
      }),
    });
    _clients.set(region, c);
  }
  return c;
}

export interface LlmCallOptions {
  modelId?: string;
  region?: string;
}

/**
 * Build the user-turn content blocks. With `withCache` and a `cachePrefix`, the
 * prefix is its own block followed by a `cachePoint`, then the uncached `user`
 * tail — so the cacheable segment is exactly the prefix. Otherwise it collapses
 * to a single text block (prefix + tail joined the same way the split reads on
 * the wire). Pure + exported so the cachePoint placement is unit-testable
 * without a live Bedrock client.
 */
export function buildUserContent(input: LlmCallInput, withCache: boolean): ContentBlock[] {
  if (withCache && input.cachePrefix) {
    // The separator lives on the UNCACHED tail block so the on-the-wire form
    // (prefix + "\n\n" + user) is byte-identical to the collapsed single-block
    // form below; only `cachePrefix` is the cached segment.
    return [
      { text: input.cachePrefix },
      { cachePoint: { type: "default" } },
      { text: `\n\n${input.user}` },
    ];
  }
  return [
    { text: input.cachePrefix ? `${input.cachePrefix}\n\n${input.user}` : input.user },
  ];
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
  const region = opts.region ?? awsRegion();
  const modelId = resolveModel("utility", opts.modelId);
  const c = client(region);

  const send = (withCache: boolean) =>
    withInflightCap(() =>
      c.send(
        new ConverseCommand({
          modelId,
          system: [{ text: input.system }],
          messages: [{ role: "user", content: buildUserContent(input, withCache) }],
          inferenceConfig: {
            maxTokens: input.maxTokens,
            temperature: input.temperature ?? 0,
          },
        }),
      ),
    );

  let resp;
  try {
    resp = await send(true);
  } catch (err) {
    // Fail-safe: a model/region that can't cache rejects the `cachePoint` with a
    // ValidationException. Retry once as a single uncached block so the call still
    // succeeds — caching is a cost optimization, never a correctness dependency.
    if (input.cachePrefix && err instanceof ValidationException) {
      resp = await send(false);
    } else {
      throw err;
    }
  }

  const text = resp.output?.message?.content?.[0]?.text ?? "";
  const u = resp.usage;
  const usage: LlmUsage | undefined = u
    ? {
        inputTokens: u.inputTokens ?? 0,
        outputTokens: u.outputTokens ?? 0,
        ...(u.cacheReadInputTokens != null
          ? { cacheReadInputTokens: u.cacheReadInputTokens }
          : {}),
        ...(u.cacheWriteInputTokens != null
          ? { cacheWriteInputTokens: u.cacheWriteInputTokens }
          : {}),
      }
    : undefined;
  return { text, modelId, usage };
}

/**
 * Resolve the LlmFn a phase should use: the injected one (tests), else a
 * production closure over `callHaiku`. Keeps every phase's resolution identical.
 */
export function resolveLlmFn(injected: LlmFn | undefined, opts: LlmCallOptions = {}): LlmFn {
  return injected ?? ((input) => callHaiku(input, opts));
}
