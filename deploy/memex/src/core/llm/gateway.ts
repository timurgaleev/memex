/**
 * LLM gateway helpers. memex is Bedrock-only, so multi-provider recipes,
 * capability classification, and stop-reason machinery don't apply here;
 * retry/backoff/timeout are delegated to the AWS SDK (tuned in the haiku.ts /
 * sonnet.ts client factories). What this adds: a per-process inflight
 * concurrency cap so the many synthesis phases that fan out in parallel can't
 * stampede Bedrock, plus an availability probe.
 */

import { NodeHttpHandler } from "@smithy/node-http-handler";
import { noteWriteTiming } from "../write-timing.ts";

const DEFAULT_MAX_INFLIGHT = 4;

function maxInflight(): number {
  const n = Number.parseInt(process.env.MEMEX_LLM_MAX_INFLIGHT ?? "", 10);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_INFLIGHT;
}

let active = 0;
const waiters: Array<() => void> = [];

/**
 * Run `fn` under the per-process inflight cap (`MEMEX_LLM_MAX_INFLIGHT`, default
 * 4). Excess callers queue FIFO until a slot frees. Per-process only (like
 * throttle.ts) — under multi-container scale-out it under-throttles, which is
 * acceptable on the single EC2.
 */
export async function withInflightCap<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= maxInflight()) {
    const waitStart = performance.now();
    await new Promise<void>((resolve) => waiters.push(resolve));
    noteWriteTiming("queueMs", performance.now() - waitStart);
  }
  active++;
  try {
    return await fn();
  } finally {
    active--;
    const next = waiters.shift();
    if (next) next();
  }
}

/** Cheap probe that a Bedrock call could plausibly authenticate (region/creds
 *  present). Not a live reachability check. */
export function isLlmAvailable(): boolean {
  return !!(
    process.env.AWS_REGION ||
    process.env.AWS_PROFILE ||
    process.env.AWS_ACCESS_KEY_ID
  );
}

const DEFAULT_REGION = "eu-west-1";

/**
 * Resolve the AWS region for a Bedrock/SDK client. A compose passthrough like
 * `AWS_REGION=${AWS_REGION}` injects an EMPTY string when the var is unset, and
 * `?? "eu-west-1"` (empty string isn't nullish) would hand the SDK region `""` —
 * which fails every call. Trim-empty-is-unset falls back to the default instead.
 */
export function awsRegion(raw: string | undefined = process.env.AWS_REGION): string {
  return raw?.trim() || DEFAULT_REGION;
}

const DEFAULT_LLM_TIMEOUT_MS = 30_000;

/**
 * Resolve the Bedrock request timeout in ms (`MEMEX_LLM_TIMEOUT_MS`). Mirrors
 * `maxInflight`: an empty or non-numeric value falls back to 30s. Without this
 * guard `Number("")` is 0, which the SDK reads as "no timeout" and lets a hung
 * connection hang forever.
 */
export function llmRequestTimeoutMs(
  raw: string | undefined = process.env.MEMEX_LLM_TIMEOUT_MS,
): number {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_LLM_TIMEOUT_MS;
}

/** A per-call-kind timeout: its own knob, else `MEMEX_LLM_TIMEOUT_MS` if set,
 *  else the kind's own default. */
function kindTimeoutMs(kindRaw: string | undefined, kindDefault: number): number {
  const own = Number.parseInt(kindRaw ?? "", 10);
  if (Number.isInteger(own) && own > 0) return own;
  const shared = Number.parseInt(process.env.MEMEX_LLM_TIMEOUT_MS ?? "", 10);
  return Number.isInteger(shared) && shared > 0 ? shared : kindDefault;
}

/** Utility-tier chat (Haiku): short prompts, short answers. */
export function utilityTimeoutMs(): number {
  return kindTimeoutMs(process.env.MEMEX_LLM_UTILITY_TIMEOUT_MS, DEFAULT_LLM_TIMEOUT_MS);
}

/**
 * Reasoning-tier chat (Sonnet). Longer by default: until request timeouts were
 * made to throw, a long generation simply ran on past 30 s, and it must not
 * start failing just because the limit became real.
 */
export function reasoningTimeoutMs(): number {
  return kindTimeoutMs(process.env.MEMEX_LLM_REASONING_TIMEOUT_MS, 120_000);
}

/**
 * Converse does not stream, so the socket stays silent until the WHOLE answer
 * is generated: a call allowed 8000 output tokens legitimately takes minutes. A
 * fixed timeout would cut exactly those calls, and the SDK would then re-send
 * them — each attempt generating, and likely billing, in full. So a chat call's
 * timeout is its tier's base plus a per-token allowance for the output it may
 * produce (25 ms/token ≈ 40 tokens/s, well under what either tier sustains).
 * A genuinely hung request still ends; a long one no longer does.
 */
export function chatTimeoutMs(baseMs: number, maxTokens: number): number {
  return baseMs + Math.max(0, maxTokens) * 25;
}

/** Titan embeddings: one short input, a fixed-size vector back. */
export function embedTimeoutMs(): number {
  return kindTimeoutMs(process.env.MEMEX_EMBED_TIMEOUT_MS, 10_000);
}

/**
 * Transport settings every Bedrock client in memex shares. The SDK retries
 * throttles, 5xx and timeouts itself (adaptive mode also slows the send rate
 * when throttled), so nothing above it retries again. `throwOnRequestTimeout`
 * is what makes the timeout real: without it the handler only logs a warning
 * and the request keeps running — which is how a write reached 116 s.
 */
export function bedrockClientConfig(timeoutMs: number): {
  maxAttempts: number;
  retryMode: "adaptive";
  requestHandler: NodeHttpHandler;
} {
  return {
    maxAttempts: 4,
    retryMode: "adaptive",
    requestHandler: new NodeHttpHandler({ requestTimeout: timeoutMs, throwOnRequestTimeout: true }),
  };
}
