/**
 * mcp/request-log-db.ts — opt-in DB sink for the MCP request log
 * (`mcp_request_log`, migration 046), the table the admin Request Log page
 * reads. memex's default request observability is the JSONL audit trail +
 * console line (param-redaction.ts `logToolCall`); this adds a THIRD sink — a
 * redacted row per tool call — for operators who want the in-dashboard feed.
 *
 * Strictly opt-in (`MEMEX_REQUEST_LOG_DB=1`, default OFF) so the hot path takes
 * no extra write unless enabled. Fire-and-forget + fully swallowed: a logging
 * failure must never turn a successful tool call into an error. Redacted: only
 * the param SUMMARY (`summarizeMcpParams`) and a known-only tool name are
 * stored — never raw param values, never an unknown caller-controlled name.
 */
import type { Engine } from "../core/engine/interface.ts";
import { summarizeMcpParams, isKnownTool } from "./param-redaction.ts";

/** Whether the DB request-log sink is enabled. */
export function requestLogDbEnabled(): boolean {
  return process.env["MEMEX_REQUEST_LOG_DB"] === "1";
}

export interface RequestLogEntry {
  /** The MCP tool name (stored only when declared; else "unknown"). */
  tool: string;
  /** Caller identity — an OAuth client id, else the ingress class. */
  agentName: string;
  /** Wall-clock dispatch latency in ms. */
  latencyMs: number;
  /** Whether the tool call succeeded. */
  ok: boolean;
  /** Raw params — redacted to a summary before storage, never stored raw. */
  params: unknown;
}

/**
 * Insert one redacted row into `mcp_request_log`. No-op unless enabled.
 * Fire-and-forget: returns immediately; the insert runs detached and any fault
 * (including a missing table on a pre-046 brain) is swallowed.
 */
export function logToolCallToDb(engine: Engine, e: RequestLogEntry): void {
  if (!requestLogDbEnabled()) return;
  const operation = isKnownTool(e.tool) ? e.tool : "unknown";
  const summary = summarizeMcpParams(e.tool, e.params);
  void engine
    .query(
      `INSERT INTO mcp_request_log (agent_name, operation, latency_ms, status, params)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [e.agentName, operation, Math.round(e.latencyMs), e.ok ? "success" : "error", JSON.stringify(summary)],
    )
    .catch(() => {
      /* best-effort — never break request handling */
    });
}
