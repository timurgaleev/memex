/**
 * Bedrock Titan v2 embedding client.
 *
 * Uses amazon.titan-embed-text-v2:0 from AWS Bedrock to produce 1024-dim
 * normalized vectors. Auth is via the EC2 IAM role (per CLAUDE.md
 * feedback_bedrock_auth: AWS_PROFILE=default + ~/.aws/config with
 * credential_source = Ec2InstanceMetadata; the AWS SDK picks this up).
 */
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";

/** Canonical Titan v2 model id — the default for `embedText` and the model
 *  recorded by the embedding backfill, so the two never drift apart. */
export const DEFAULT_MODEL_ID = "amazon.titan-embed-text-v2:0";

/** Titan v2's native output width and the brain's stored `vector(N)` column
 *  width. The provider/model swap (a higher-dim embedder + full re-embed +
 *  column migration) is gated; until then this stays 1024. Surfaced as config
 *  so a future swap is an env change here, not a hunt for hardcoded literals —
 *  the swap must move this default AND the `vector(...)` column width together. */
const FALLBACK_DIMENSIONS = 1024;

/** Resolve the embedding width from `MEMEX_EMBED_DIM` (fail-loud) or the
 *  Titan-v2 default. Validated once at module load so a bad env fails the
 *  process, not a silent wrong-width vector deep in the index path. */
export function resolveEmbedDimensions(
  raw: string | undefined = process.env.MEMEX_EMBED_DIM,
): number {
  if (raw === undefined || raw.trim() === "") return FALLBACK_DIMENSIONS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(
      `MEMEX_EMBED_DIM must be a positive integer, got: ${JSON.stringify(raw)}`,
    );
  }
  return n;
}

export const EMBED_DIMENSIONS = resolveEmbedDimensions();
const DEFAULT_REGION = process.env.AWS_REGION ?? "eu-west-1";

/** Provider tag folded into the embedding signature. Titan is served through
 *  Bedrock; a future provider swap changes this AND the model id together. */
const EMBED_PROVIDER = "bedrock";

/**
 * Provenance signature for a stored embedding: `provider:model:dims`. Stamped
 * on each `embeddings` row at write time (migration 066) so a model or
 * dimension swap is self-describing. The stale/backfill loop compares a row's
 * stored signature to the current one and re-embeds only rows whose signature
 * actually differs — a NULL (legacy, pre-signature) row is left untouched, so
 * turning this on never forces a full re-embed of the existing corpus.
 */
export function embeddingSignature(
  modelId: string = DEFAULT_MODEL_ID,
  dims: number = EMBED_DIMENSIONS,
): string {
  return `${EMBED_PROVIDER}:${modelId}:${dims}`;
}

let _defaultClient: BedrockRuntimeClient | null = null;

function getClient(): BedrockRuntimeClient {
  if (_defaultClient === null) {
    _defaultClient = new BedrockRuntimeClient({ region: DEFAULT_REGION });
  }
  return _defaultClient;
}

export interface EmbedOptions {
  client?: BedrockRuntimeClient;
  modelId?: string;
  /**
   * Optional abort signal threaded into the Bedrock `send()` call so a caller
   * with a deadline (e.g. the bounded query-embed in search) can cancel the
   * in-flight request instead of leaking it past the budget.
   */
  abortSignal?: AbortSignal;
}

interface TitanResponseV2 {
  embedding: number[];
  inputTextTokenCount?: number;
}

/**
 * Embed a single text string, returning a 1024-dim float vector.
 * Throws on empty input or malformed/wrong-dimension response.
 */
export async function embedText(
  text: string,
  opts: EmbedOptions = {},
): Promise<number[]> {
  if (!text || !text.trim()) {
    throw new Error("embedText: input must be a non-empty string");
  }
  const client = opts.client ?? getClient();
  const modelId = opts.modelId ?? DEFAULT_MODEL_ID;

  const command = new InvokeModelCommand({
    modelId,
    body: JSON.stringify({
      inputText: text,
      dimensions: EMBED_DIMENSIONS,
      normalize: true,
    }),
    contentType: "application/json",
    accept: "application/json",
  });

  const response = await client.send(command, { abortSignal: opts.abortSignal });
  if (!response.body) {
    throw new Error("embedText: empty response body from Bedrock");
  }
  const decoded = new TextDecoder().decode(response.body);
  const parsed = JSON.parse(decoded) as TitanResponseV2;
  if (!Array.isArray(parsed.embedding)) {
    throw new Error("embedText: response missing 'embedding' array");
  }
  if (parsed.embedding.length !== EMBED_DIMENSIONS) {
    throw new Error(
      `embedText: expected ${EMBED_DIMENSIONS}-dim vector, got ${parsed.embedding.length}`,
    );
  }
  return parsed.embedding;
}
