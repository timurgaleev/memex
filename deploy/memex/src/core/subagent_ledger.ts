/**
 * Subagent durable ledger (Phase A.5).
 *
 * Used by the future subagent runner to write every conversation
 * turn and every tool execution into Postgres so a crash mid-run
 * can replay deterministically: the supervisor reads the message
 * log to rebuild context, and the tool_executions log to decide
 * which calls have already happened and don't need re-running.
 *
 * No MCP surface in A.5 -- schema + thin CRUD only. The runner
 * itself + its MCP exposure lands in a later phase.
 *
 * SECURITY (read before wiring A.6 MCP tools):
 *   * `subagent_messages.content` is the raw Bedrock Converse
 *     payload -- system prompts, tool inputs that may carry
 *     OAuth tokens / Bearer tokens / file contents, and model
 *     output. INTERNAL-TOKEN ONLY in public reads.
 *   * `subagent_tool_executions.input/output/error` likewise
 *     carry arbitrary tool payloads. INTERNAL-TOKEN ONLY.
 *   * If a public projection is ever needed it MUST be a strict
 *     server-side allowlist of `{id, job_id, turn_num, role,
 *     tool_name, status, started_at, finished_at}` -- with the
 *     content/input/output/error columns dropped at the SQL
 *     layer, not via regex.
 */
import type { Storage } from "./storage.ts";

export type SubagentRole = "user" | "assistant" | "tool_result" | "system";

const VALID_ROLES: ReadonlySet<SubagentRole> = new Set([
  "user",
  "assistant",
  "tool_result",
  "system",
]);

const MAX_CONTENT_BYTES = 1_000_000; // ~1 MB JSONB cap
const MAX_TOOL_NAME_LEN = 256;
const MAX_LIST_LIMIT = 1000;
const DEFAULT_LIST_LIMIT = 1000;

export interface AppendMessageInput {
  job_id: string;
  turn_num: number;
  role: SubagentRole;
  content: Record<string, unknown> | Array<unknown>;
}

export interface MessageRow {
  id: number;
  job_id: string;
  turn_num: number;
  role: SubagentRole;
  content: unknown;
  written_at: string;
}

function serialiseBounded(value: unknown, label: string): string {
  const s = JSON.stringify(value);
  if (s.length > MAX_CONTENT_BYTES) {
    throw new Error(
      `${label} exceeds ${MAX_CONTENT_BYTES} bytes (${s.length})`,
    );
  }
  return s;
}

export async function appendMessage(
  storage: Storage,
  input: AppendMessageInput,
): Promise<{ id: number; inserted: boolean }> {
  if (!input.job_id) throw new Error("job_id is required");
  if (!Number.isInteger(input.turn_num) || input.turn_num < 0) {
    throw new Error("turn_num must be a non-negative integer");
  }
  if (!VALID_ROLES.has(input.role)) {
    throw new Error(
      `role must be one of ${[...VALID_ROLES].join("|")} (got ${input.role})`,
    );
  }
  const contentJson = serialiseBounded(input.content, "content");
  // UNIQUE(job_id, turn_num) makes duplicate turn-num inserts
  // idempotent: a worker retry replays the same INSERT and the
  // first one wins. The conflicting caller falls through to a
  // SELECT to recover the winning row's id.
  const r = await storage.engine().query<{ id: number }>(
    `INSERT INTO subagent_messages (job_id, turn_num, role, content)
     VALUES ($1, $2, $3, $4::text::jsonb)
     ON CONFLICT (job_id, turn_num) DO NOTHING
     RETURNING id`,
    [input.job_id, input.turn_num, input.role, contentJson],
  );
  if (r.rows.length === 0) {
    const existing = await storage.engine().query<{ id: number }>(
      `SELECT id FROM subagent_messages WHERE job_id = $1 AND turn_num = $2`,
      [input.job_id, input.turn_num],
    );
    if (existing.rows.length === 0) {
      throw new Error(
        `appendMessage: ON CONFLICT fired but row not found for ` +
          `(job_id=${input.job_id}, turn_num=${input.turn_num}); ` +
          `likely a CASCADE delete race`,
      );
    }
    return { id: existing.rows[0]!.id, inserted: false };
  }
  return { id: r.rows[0]!.id, inserted: true };
}

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit < 1) {
    return DEFAULT_LIST_LIMIT;
  }
  return Math.min(Math.floor(limit), MAX_LIST_LIMIT);
}

export async function listMessages(
  storage: Storage,
  jobId: string,
  opts: { limit?: number } = {},
): Promise<MessageRow[]> {
  const limit = clampLimit(opts.limit);
  const r = await storage.engine().query<MessageRow>(
    `SELECT id, job_id, turn_num, role, content,
            written_at::text AS written_at
       FROM subagent_messages
       WHERE job_id = $1
       ORDER BY turn_num ASC
       LIMIT $2`,
    [jobId, limit],
  );
  return r.rows;
}

export type ToolExecStatus = "pending" | "succeeded" | "failed" | "skipped";

const VALID_TOOL_STATUS: ReadonlySet<ToolExecStatus> = new Set([
  "pending",
  "succeeded",
  "failed",
  "skipped",
]);

export interface BeginToolExecutionInput {
  job_id: string;
  turn_num: number;
  tool_name: string;
  input: Record<string, unknown>;
}

export interface ToolExecutionRow {
  id: number;
  job_id: string;
  turn_num: number;
  tool_name: string;
  input: unknown;
  output: unknown;
  status: ToolExecStatus;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

/**
 * Insert a `pending` execution row BEFORE invoking the tool. The
 * supervisor's crash-recovery sweep scans pending rows older than
 * a timeout and decides whether to retry or skip them.
 *
 * TOCTOU constraint for the future supervisor (A.6+): bind each
 * pending row to a `supervisor_run_id`/`worker_id` and only that
 * worker may retry it on resume. Cross-worker pending rows MUST
 * be `skipped`, not re-executed -- otherwise a single
 * internal-token holder who can write a pending row causes the
 * next sweep to invoke `tool_name` with their forged `input`,
 * effectively a stored-command injection into the agent loop.
 */
export async function beginToolExecution(
  storage: Storage,
  input: BeginToolExecutionInput,
): Promise<{ id: number }> {
  if (!input.job_id) throw new Error("job_id is required");
  if (!Number.isInteger(input.turn_num) || input.turn_num < 0) {
    throw new Error("turn_num must be a non-negative integer");
  }
  if (typeof input.tool_name !== "string" || input.tool_name.length === 0) {
    throw new Error("tool_name is required");
  }
  if (input.tool_name.length > MAX_TOOL_NAME_LEN) {
    throw new Error(
      `tool_name exceeds ${MAX_TOOL_NAME_LEN} chars (${input.tool_name.length})`,
    );
  }
  const inputJson = serialiseBounded(input.input, "input");
  const r = await storage.engine().query<{ id: number }>(
    `INSERT INTO subagent_tool_executions
       (job_id, turn_num, tool_name, input, status)
     VALUES ($1, $2, $3, $4::text::jsonb, 'pending')
     RETURNING id`,
    [input.job_id, input.turn_num, input.tool_name, inputJson],
  );
  return { id: r.rows[0]!.id };
}

export interface FinishToolExecutionInput {
  id: number;
  status: Exclude<ToolExecStatus, "pending">;
  output?: unknown;
  error?: string;
}

/**
 * Transition a `pending` row to a terminal status. The
 * `WHERE status = 'pending'` predicate makes the UPDATE a
 * compare-and-set: exactly one of two concurrent finishers
 * wins, the other gets `updated: false` and the returned
 * `current_status` reveals the winning value so the caller
 * can reconcile (e.g. log a divergent `succeeded`-vs-`failed`
 * race).
 */
export async function finishToolExecution(
  storage: Storage,
  input: FinishToolExecutionInput,
): Promise<{ updated: boolean; current_status: ToolExecStatus | null }> {
  if (!Number.isInteger(input.id)) throw new Error("id is required");
  // Widened on purpose: the declared union excludes "pending", so tsc reads
  // this as dead — but `input` arrives as JSON over MCP and the type is a
  // claim, not a guarantee. Validating a trust boundary against its own type
  // annotation validates nothing.
  const status: string = input.status;
  if (!VALID_TOOL_STATUS.has(input.status) || status === "pending") {
    throw new Error(
      `status must be one of succeeded|failed|skipped (got ${input.status})`,
    );
  }
  const outputJson =
    input.output === undefined ? null : serialiseBounded(input.output, "output");
  const errorText =
    typeof input.error === "string" && input.error.length > MAX_CONTENT_BYTES
      ? input.error.slice(0, MAX_CONTENT_BYTES)
      : (input.error ?? null);
  const r = await storage.engine().query<{ status: ToolExecStatus }>(
    `WITH attempted AS (
       UPDATE subagent_tool_executions
         SET status = $2,
             output = $3::text::jsonb,
             error = $4,
             finished_at = NOW()
         WHERE id = $1 AND status = 'pending'
         RETURNING status
     )
     SELECT status FROM attempted
     UNION ALL
     SELECT status FROM subagent_tool_executions
       WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM attempted)
     LIMIT 1`,
    [input.id, input.status, outputJson, errorText],
  );
  const row = r.rows[0];
  if (!row) return { updated: false, current_status: null };
  return {
    updated: row.status === input.status,
    current_status: row.status,
  };
}

export async function listToolExecutions(
  storage: Storage,
  jobId: string,
  opts: { limit?: number } = {},
): Promise<ToolExecutionRow[]> {
  const limit = clampLimit(opts.limit);
  const r = await storage.engine().query<ToolExecutionRow>(
    `SELECT id, job_id, turn_num, tool_name, input, output,
            status, error,
            started_at::text AS started_at,
            finished_at::text AS finished_at
       FROM subagent_tool_executions
       WHERE job_id = $1
       ORDER BY turn_num ASC, started_at ASC
       LIMIT $2`,
    [jobId, limit],
  );
  return r.rows;
}
