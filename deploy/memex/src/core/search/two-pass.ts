/**
 * Two-pass rerank — feed the top-K hybrid hits to Haiku 4.5 for a more
 * precise relevance score, return the new ordering.
 *
 * Opt-in via env `MEMEX_RERANK=1` because Haiku is paid (~$1-3/mo
 * for typical use). Cheap users keep the RRF + source-boost ordering.
 *
 * Designed to fail safe: any error returns the input order unchanged AND is
 * recorded to the rerank-failure audit JSONL (rerank-audit.ts, opt-in via
 * MEMEX_AUDIT_DIR) so silent degradation is greppable. The Bedrock call runs
 * under a per-call wall-clock timeout (MEMEX_RERANK_TIMEOUT_MS, default
 * 5000ms — reference contract) so a hung connection can't stall search.
 */
import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";
import type { ChunkScore } from "./dedup.ts";
import {
  hashQueryForAudit,
  logRerankFailure,
  type RerankFailureReason,
} from "./rerank-audit.ts";
import { awsRegion } from "../llm/gateway.ts";

const DEFAULT_MODEL = "eu.anthropic.claude-haiku-4-5-20251001-v1:0";

/** Per-call rerank timeout (ms). Reference default: 5000. */
const DEFAULT_TIMEOUT_MS = 5_000;

function rerankTimeoutMs(): number {
  const n = Number(process.env.MEMEX_RERANK_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

let _client: BedrockRuntimeClient | null = null;
function client(region: string): BedrockRuntimeClient {
  if (!_client) _client = new BedrockRuntimeClient({ region });
  return _client;
}

export interface ChunkPayloadForRerank {
  content: string;
  title: string | null;
  sourcePath: string;
}

export interface RerankOptions {
  modelId?: string;
  region?: string;
  /** Per-call timeout override (ms). Defaults to MEMEX_RERANK_TIMEOUT_MS/5000. */
  timeoutMs?: number;
}

const SYSTEM_PROMPT = `You are a relevance reranker. You see a search query and a list of candidate chunks (numbered 0..N-1). Output ONE LINE: a JSON array of indices, in the order most-to-least relevant to the query. Output nothing else. Example: [3,0,1,2,4]`;

export async function rerank<T extends ChunkPayloadForRerank>(
  query: string,
  hits: readonly ChunkScore<T>[],
  opts: RerankOptions = {},
): Promise<ChunkScore<T>[]> {
  if (hits.length <= 1) return [...hits];
  const items = hits.map((h, i) => {
    const title = h.payload?.title ?? "(untitled)";
    const path = h.payload?.sourcePath ?? "";
    const snippet = (h.payload?.content ?? "").slice(0, 600).replace(/\s+/g, " ");
    return `${i}: [${title} — ${path}] ${snippet}`;
  });
  const userMessage = `QUERY: ${query}\n\nCANDIDATES:\n${items.join("\n")}`;

  const region = opts.region ?? awsRegion();
  const modelId = opts.modelId ?? DEFAULT_MODEL;
  const timeoutMs = opts.timeoutMs ?? rerankTimeoutMs();
  const c = client(region);

  const audit = (reason: RerankFailureReason, err: unknown): void => {
    logRerankFailure({
      model: modelId,
      reason,
      query_hash: hashQueryForAudit(query),
      doc_count: hits.length,
      error_summary: err instanceof Error ? err.message : String(err),
    });
  };

  try {
    const resp = await c.send(
      new ConverseCommand({
        modelId,
        system: [{ text: SYSTEM_PROMPT }],
        messages: [{ role: "user", content: [{ text: userMessage }] }],
        inferenceConfig: { maxTokens: 200, temperature: 0 },
      }),
      // Per-call deadline: a stuck upstream must not hold search hostage.
      { abortSignal: AbortSignal.timeout(timeoutMs) },
    );
    const text = resp.output?.message?.content?.[0]?.text?.trim() ?? "[]";
    const match = text.match(/\[[^\]]*\]/);
    if (!match) {
      audit("parse", `no index array in model output (${text.slice(0, 80)})`);
      return [...hits];
    }
    const order = JSON.parse(match[0]) as unknown;
    if (!Array.isArray(order)) {
      audit("parse", "model output parsed to a non-array");
      return [...hits];
    }
    const seen = new Set<number>();
    const out: ChunkScore<T>[] = [];
    let rerankedScore = hits.length;
    for (const idx of order) {
      if (
        typeof idx === "number" &&
        Number.isInteger(idx) &&
        idx >= 0 &&
        idx < hits.length &&
        !seen.has(idx)
      ) {
        const h = hits[idx]!;
        out.push({ ...h, score: rerankedScore-- });
        seen.add(idx);
      }
    }
    // Append any candidates the rerank missed in original order.
    for (let i = 0; i < hits.length; i++) {
      if (!seen.has(i)) {
        out.push(hits[i]!);
      }
    }
    return out;
  } catch (err) {
    const timedOut =
      err instanceof Error &&
      (err.name === "AbortError" || err.name === "TimeoutError");
    audit(timedOut ? "timeout" : "upstream", err);
    return [...hits];
  }
}
