/**
 * Rerank failure audit — best-effort JSONL trail for the two-pass reranker.
 *
 * The reranker is fail-open (any error returns the input order), which makes
 * silent degradation invisible: a wedged model or an expired credential can
 * disable reranking for weeks with zero signal. So memex persists every
 * rerank failure to an audit JSONL that doctor can grep, using the same
 * opt-in surface as the MCP audit trail (`MEMEX_AUDIT_DIR`) and
 * an ISO-week-rotated `rerank-failures-<week>.jsonl`.
 *
 * Best-effort by contract: any write failure is swallowed — the audit trail
 * must never break search. The query is recorded as a SHA-256 prefix, never
 * as text (privacy).
 */
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { auditDir, isoWeekKey } from "../audit-week-file.ts";

export type RerankFailureReason = "timeout" | "parse" | "upstream" | "unknown";

export interface RerankFailureRecord {
  model: string;
  reason: RerankFailureReason;
  query_hash: string;
  doc_count: number;
  error_summary: string;
}

/** SHA-256 prefix (8 chars) of the query text — privacy-preserving audit id. */
export function hashQueryForAudit(query: string): string {
  return createHash("sha256").update(query, "utf8").digest("hex").slice(0, 8);
}

/** Append one failure record; no-op unless MEMEX_AUDIT_DIR is set. */
export function logRerankFailure(
  record: RerankFailureRecord,
  now: Date = new Date(),
): void {
  const dir = auditDir();
  if (!dir) return;
  try {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `rerank-failures-${isoWeekKey(now)}.jsonl`);
    appendFileSync(file, JSON.stringify({ ts: now.toISOString(), ...record }) + "\n");
  } catch {
    // Best-effort: an unwritable audit dir must never break search.
  }
}
