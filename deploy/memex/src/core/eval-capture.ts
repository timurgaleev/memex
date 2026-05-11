/**
 * Auto-capture rows into `eval_candidates`.
 *
 * Sister of `core/eval-replay.ts` (the curated regression set) — this
 * file owns the firehose that lands every production retrieval call
 * for later promotion. Gated by `evalCapture.enabled` in config; PII
 * scrubbed in-process before INSERT when `evalCapture.scrub` is true
 * (default).
 *
 * The hot path is one INSERT per search call. We don't await it from
 * the searcher's critical path — capture failures are logged and
 * never block the user-facing response. `classifyCaptureFailure`
 * categorizes the error for triage.
 */
import type { Engine } from "./engine/interface.ts";
import type { Config } from "./config.ts";
import { scrub } from "./eval-capture-scrub.ts";
import type { SearchCaptureInfo } from "./search/hybrid.ts";

export type CaptureToolName =
  | "search"
  | "query"
  | "mcp.search"
  | "mcp.query"
  | "cli.search"
  | "http.search";

export type CaptureSearchMode = "hybrid" | "keyword";
export type CaptureDetail = "low" | "medium" | "high";

export interface CaptureContext {
  toolName: CaptureToolName;
  /** Raw query — scrubber runs here at write time when scrub=true. */
  query: string;
  /** Top-K result document IDs in rank order. */
  resultDocIds: string[];
  k: number;
  searchMode: CaptureSearchMode;
  latencyMs: number;
  /** Side-channel metadata from hybridSearch (vector_enabled, intent, etc). */
  meta?: Record<string, unknown>;
  /** True for MCP callers, false for local CLI. */
  remote?: boolean;
  /** `expand` flag as requested by the caller (query path only). */
  expandEnabled?: boolean | null;
  /** `detail` flag as requested (query path only). */
  detail?: CaptureDetail | null;
  jobId?: string | null;
  subagentId?: string | null;
}

export interface CaptureOptions {
  /** When false, store the raw query verbatim. Default true. */
  scrub?: boolean;
}

export interface CaptureConfig {
  enabled?: boolean;
  scrub?: boolean;
}

export function isEvalCaptureEnabled(
  cfg: { evalCapture?: CaptureConfig } | null | undefined,
): boolean {
  return Boolean(cfg?.evalCapture?.enabled);
}

export function isEvalScrubEnabled(
  cfg: { evalCapture?: CaptureConfig } | null | undefined,
): boolean {
  // Scrub defaults TRUE — the safe default. Caller has to opt out.
  return cfg?.evalCapture?.scrub !== false;
}

/**
 * Build the row to insert. Pure function — separated so tests can
 * exercise the scrub-on-write decision without an engine.
 */
export interface CapturedRowInput {
  tool_name: CaptureToolName;
  query: string;
  scrubbed: boolean;
  k: number;
  search_mode: CaptureSearchMode;
  result_doc_ids: string[];
  result_count: number;
  latency_ms: number;
  meta: Record<string, unknown>;
  remote: boolean;
  expand_enabled: boolean | null;
  detail: CaptureDetail | null;
  job_id: string | null;
  subagent_id: string | null;
}

export function buildCandidateInput(
  ctx: CaptureContext,
  opts: CaptureOptions = {},
): CapturedRowInput {
  const shouldScrub = opts.scrub !== false;
  return {
    tool_name: ctx.toolName,
    query: shouldScrub ? scrub(ctx.query) : ctx.query,
    scrubbed: shouldScrub,
    k: ctx.k,
    search_mode: ctx.searchMode,
    result_doc_ids: ctx.resultDocIds,
    result_count: ctx.resultDocIds.length,
    latency_ms: Math.max(0, Math.round(ctx.latencyMs)),
    meta: ctx.meta ?? {},
    remote: ctx.remote ?? false,
    expand_enabled: ctx.expandEnabled ?? null,
    detail: ctx.detail ?? null,
    job_id: ctx.jobId ?? null,
    subagent_id: ctx.subagentId ?? null,
  };
}

export type CaptureFailureReason =
  | "engine-closed"
  | "schema-missing"
  | "constraint-violation"
  | "timeout"
  | "unknown";

/**
 * Categorize an INSERT failure so callers can decide whether to retry,
 * disable capture, or surface a friction event. We don't ever throw
 * from the capture path itself — the user-facing search has already
 * succeeded by the time we attempt the INSERT.
 */
export function classifyCaptureFailure(err: unknown): CaptureFailureReason {
  const m = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  if (m.includes("connection") && m.includes("closed")) return "engine-closed";
  if (m.includes("relation") && m.includes("does not exist")) return "schema-missing";
  if (m.includes("violates") || m.includes("check constraint"))
    return "constraint-violation";
  if (m.includes("timeout") || m.includes("timed out")) return "timeout";
  return "unknown";
}

export interface CaptureResult {
  ok: boolean;
  reason?: CaptureFailureReason;
  rowId?: number;
}

/**
 * Insert a candidate row. Never throws — failures are returned via
 * `{ ok: false, reason }` so the caller (a hybridSearch hook) can
 * log + carry on.
 */
export async function captureEvalCandidate(
  engine: Engine,
  ctx: CaptureContext,
  opts: CaptureOptions = {},
): Promise<CaptureResult> {
  try {
    const row = buildCandidateInput(ctx, opts);
    const r = await engine.query<{ id: number }>(
      `INSERT INTO eval_candidates (
         tool_name, query, scrubbed, k, search_mode,
         result_doc_ids, result_count, latency_ms, meta, remote,
         expand_enabled, detail, job_id, subagent_id
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6::jsonb, $7, $8, $9::jsonb, $10,
         $11, $12, $13, $14
       ) RETURNING id`,
      [
        row.tool_name,
        row.query,
        row.scrubbed,
        row.k,
        row.search_mode,
        JSON.stringify(row.result_doc_ids),
        row.result_count,
        row.latency_ms,
        JSON.stringify(row.meta),
        row.remote,
        row.expand_enabled,
        row.detail,
        row.job_id,
        row.subagent_id,
      ],
    );
    return { ok: true, rowId: r.rows[0]?.id };
  } catch (e) {
    return { ok: false, reason: classifyCaptureFailure(e) };
  }
}

export interface CaptureCallbackContext {
  toolName: CaptureToolName;
  remote: boolean;
  jobId?: string | null;
  subagentId?: string | null;
  expandEnabled?: boolean | null;
  detail?: CaptureDetail | null;
}

/**
 * Bind an `onCapture` callback for `hybridSearch` based on config.
 * Returns `undefined` when capture is disabled — the call site can
 * spread it into hybridSearch options without branching:
 *
 *   const onCapture = makeCaptureCallback(engine, config, ctx);
 *   await hybridSearch(storage, q, { k, ...(onCapture ? { onCapture } : {}) });
 */
export function makeCaptureCallback(
  engine: Engine,
  config: Pick<Config, "evalCapture"> | null | undefined,
  ctx: CaptureCallbackContext,
): ((info: SearchCaptureInfo) => Promise<void>) | undefined {
  if (!isEvalCaptureEnabled(config)) return undefined;
  const scrubOn = isEvalScrubEnabled(config);
  return async (info) => {
    const captureCtx: CaptureContext = {
      toolName: ctx.toolName,
      query: info.query,
      resultDocIds: info.resultDocIds,
      k: info.k,
      searchMode: "hybrid",
      latencyMs: info.latencyMs,
      meta: { intent: info.intent, rerank: info.rerank, expansion: info.expansion },
      remote: ctx.remote,
      ...(ctx.expandEnabled !== undefined ? { expandEnabled: ctx.expandEnabled } : {}),
      ...(ctx.detail !== undefined ? { detail: ctx.detail } : {}),
      ...(ctx.jobId !== undefined ? { jobId: ctx.jobId } : {}),
      ...(ctx.subagentId !== undefined ? { subagentId: ctx.subagentId } : {}),
    };
    await captureEvalCandidate(engine, captureCtx, { scrub: scrubOn });
  };
}
