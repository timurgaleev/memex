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
const DEFAULT_DIMENSIONS = 1024;
const DEFAULT_REGION = process.env.AWS_REGION ?? "eu-west-1";

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
      dimensions: DEFAULT_DIMENSIONS,
      normalize: true,
    }),
    contentType: "application/json",
    accept: "application/json",
  });

  const response = await client.send(command);
  if (!response.body) {
    throw new Error("embedText: empty response body from Bedrock");
  }
  const decoded = new TextDecoder().decode(response.body);
  const parsed = JSON.parse(decoded) as TitanResponseV2;
  if (!Array.isArray(parsed.embedding)) {
    throw new Error("embedText: response missing 'embedding' array");
  }
  if (parsed.embedding.length !== DEFAULT_DIMENSIONS) {
    throw new Error(
      `embedText: expected ${DEFAULT_DIMENSIONS}-dim vector, got ${parsed.embedding.length}`,
    );
  }
  return parsed.embedding;
}
