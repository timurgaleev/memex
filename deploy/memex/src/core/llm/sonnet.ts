/**
 * Bedrock Claude (Sonnet) call helper — the paid, higher-reasoning tier for
 * fact extraction. Mirrors the Nova helper's ConverseCommand shape but returns
 * token usage so the BudgetTracker can price each call.
 *
 * memex is Nova-only everywhere EXCEPT this opt-in, default-OFF conversation→
 * facts path, where the operator explicitly chose Sonnet (reference parity) for
 * the notability/salience judgment Nova Lite is weaker at. Sonnet runs through
 * the SAME Bedrock account as Titan/Nova — notes never leave AWS — via an EU
 * cross-region inference profile (`eu.anthropic.*`). The exact profile id is
 * config (`MEMEX_FACTS_MODEL`); confirm the version suffix in the Bedrock
 * console and widen `terraform/iam.tf` bedrock:InvokeModel to that ARN.
 */
import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";

/** EU cross-region inference profile for Claude Sonnet 4.6. Operator confirms
 *  the exact version suffix; override via MEMEX_FACTS_MODEL. */
export const DEFAULT_SONNET_MODEL = "eu.anthropic.claude-sonnet-4-6-v1:0";

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
}

/** Injectable seam — production wires `callSonnet`; tests pass a fake. */
export type SonnetFn = (input: SonnetCallInput) => Promise<SonnetCallResult>;

const _clients = new Map<string, BedrockRuntimeClient>();
function client(region: string): BedrockRuntimeClient {
  let c = _clients.get(region);
  if (!c) {
    c = new BedrockRuntimeClient({ region });
    _clients.set(region, c);
  }
  return c;
}

export interface CallSonnetOptions {
  modelId?: string;
  region?: string;
}

/** Production Sonnet call. Throws on any Bedrock/network error — the caller's
 *  budget loop decides whether to record a pessimistic cost and stop. */
export async function callSonnet(
  input: SonnetCallInput,
  opts: CallSonnetOptions = {},
): Promise<SonnetCallResult> {
  const region = opts.region ?? process.env["AWS_REGION"] ?? "eu-west-1";
  const modelId =
    opts.modelId ?? process.env["MEMEX_FACTS_MODEL"] ?? DEFAULT_SONNET_MODEL;
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
  return {
    text,
    modelId,
    usage: {
      inputTokens: resp.usage?.inputTokens ?? 0,
      outputTokens: resp.usage?.outputTokens ?? 0,
    },
  };
}

export function resolveSonnetFn(
  injected: SonnetFn | undefined,
  opts: CallSonnetOptions = {},
): SonnetFn {
  return injected ?? ((input) => callSonnet(input, opts));
}
