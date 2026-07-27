/**
 * Bedrock Claude (Sonnet) call helper — the paid, higher-reasoning tier for
 * fact extraction and the opt-in paid slices. Mirrors the Haiku utility helper's
 * ConverseCommand shape but returns token usage so the BudgetTracker can price
 * each call.
 *
 * memex runs the Claude Haiku utility tier everywhere EXCEPT this
 * higher-reasoning path (conversation→facts + the opt-in slices), where the
 * operator chose Sonnet for the notability/salience judgment Haiku is weaker at.
 * Sonnet runs through the SAME Bedrock account as Titan/Haiku — notes never leave
 * AWS — via an EU cross-region inference profile (`eu.anthropic.*`). The exact
 * profile id is config (`MEMEX_FACTS_MODEL`); confirm the version suffix in the
 * Bedrock console and widen `terraform/iam.tf` bedrock:InvokeModel to that ARN.
 */
import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { resolveModel } from "./resolve-model.ts";
import { awsRegion, llmRequestTimeoutMs, withInflightCap } from "./gateway.ts";

/** EU cross-region inference profile for Claude Sonnet 4.6 — verified ACTIVE +
 *  invokable in eu-west-1 (no version suffix). Override via MEMEX_FACTS_MODEL
 *  (e.g. `eu.anthropic.claude-haiku-4-5-20251001-v1:0` for the cheaper tier). */
export const DEFAULT_SONNET_MODEL = "eu.anthropic.claude-sonnet-4-6";

export interface SonnetCallInput {
  system: string;
  user: string;
  maxTokens: number;
  temperature?: number;
}

export interface SonnetUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface SonnetCallResult {
  text: string;
  modelId: string;
  usage: SonnetUsage;
  /**
   * Bedrock Converse's `stopReason` — "end_turn", "max_tokens",
   * "stop_sequence", … A caller that parses structured output needs it to tell
   * a complete answer from one the output cap cut in half. Optional so the
   * injected test seams that predate it keep typechecking.
   */
  stopReason?: string;
}

/** Converse's stop reason when the model ran into the output-token cap. */
export const STOP_REASON_MAX_TOKENS = "max_tokens";

/** Injectable seam — production wires `callSonnet`; tests pass a fake. */
export type SonnetFn = (input: SonnetCallInput) => Promise<SonnetCallResult>;

const _clients = new Map<string, BedrockRuntimeClient>();
function client(region: string): BedrockRuntimeClient {
  let c = _clients.get(region);
  if (!c) {
    c = new BedrockRuntimeClient({
      // Tuned retry/backoff/timeout via the SDK (adaptive retry on 429/5xx +
      // MEMEX_LLM_TIMEOUT_MS request timeout, default 30s) — see gateway.ts.
      region,
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

export interface CallSonnetOptions {
  modelId?: string;
  region?: string;
}

/**
 * Resolve the paid-tier model id. Precedence: an explicit override → the
 * `MEMEX_FACTS_MODEL` env → the built-in default. Uses `||` (not `??`) so an
 * EMPTY-STRING env value — what a `${MEMEX_FACTS_MODEL:-}` docker-compose
 * passthrough injects when the operator hasn't set it — is treated as "unset"
 * and falls through to the real default. An empty model id would otherwise be
 * unpriced, and the budget guard would refuse to spend (silent "budget
 * exhausted before the call"). Every paid slice resolves its model through here.
 */
export function resolveFactsModel(override?: string): string {
  return resolveModel("reasoning", override);
}

/** Production Sonnet call. Throws on any Bedrock/network error — the caller's
 *  budget loop decides whether to record a pessimistic cost and stop. */
export async function callSonnet(
  input: SonnetCallInput,
  opts: CallSonnetOptions = {},
): Promise<SonnetCallResult> {
  const region = opts.region ?? awsRegion();
  const modelId = resolveFactsModel(opts.modelId);
  const c = client(region);
  const resp = await withInflightCap(() =>
    c.send(
      new ConverseCommand({
        modelId,
        system: [{ text: input.system }],
        messages: [{ role: "user", content: [{ text: input.user }] }],
        inferenceConfig: {
          maxTokens: input.maxTokens,
          temperature: input.temperature ?? 0,
        },
      }),
    ),
  );
  const text = resp.output?.message?.content?.[0]?.text ?? "";
  return {
    text,
    modelId,
    usage: {
      inputTokens: resp.usage?.inputTokens ?? 0,
      outputTokens: resp.usage?.outputTokens ?? 0,
    },
    ...(resp.stopReason ? { stopReason: resp.stopReason } : {}),
  };
}

export function resolveSonnetFn(
  injected: SonnetFn | undefined,
  opts: CallSonnetOptions = {},
): SonnetFn {
  return injected ?? ((input) => callSonnet(input, opts));
}
