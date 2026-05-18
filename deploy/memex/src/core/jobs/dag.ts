/**
 * Job DAG operations -- fan-out + fan-in + idempotent submit over
 * migration 019_jobs_dag. Built on top of the existing flat queue
 * in `core/jobs/queue.ts`; this module only owns the parent/child
 * extensions and the inbox.
 *
 * Operational shape:
 *
 *   parent.handler(payload, ctx):
 *     for each subtask:
 *       submitChild({parent_id, kind, payload, idempotency_key})
 *     -- parent returns; worker writes 'succeeded'? NO. The parent
 *     -- handler returns a sentinel ({pending: true}) so the
 *     -- supervisor leaves the parent row as 'running' and waits
 *     -- for its children. (Sentinel handling is the supervisor's
 *     -- concern; this module only persists the wiring.)
 *
 *   On every child completion (in queue.ts complete/fail paths):
 *     writeChildDoneInbox(parent_id, child_id, status, result)
 *
 *   On parent re-poll:
 *     unread = drainDoneInbox(parent_id)
 *     if unread accounts for ALL children:
 *       parent's handler runs the aggregation step + returns
 *
 * idempotency_key:
 *
 *   submitJob({kind, idempotency_key: "gmail/<message-id>"})
 *     -> first call creates row, returns {id, inserted: true}
 *     -> second call returns existing row, {inserted: false}
 *
 *   Critical for cron-driven recipes that retry on transient
 *   failure without double-processing.
 */
import { randomUUID } from "node:crypto";
import type { Engine } from "../engine/interface.ts";

export interface SubmitJobInput {
  kind: string;
  payload?: Record<string, unknown>;
  priority?: number;
  max_retries?: number;
  parent_job_id?: string;
  idempotency_key?: string;
  /** Schedule for a future time. Default now (immediate). */
  not_before?: Date | string;
}

export interface SubmitJobResult {
  id: string;
  inserted: boolean;
  depth: number;
}

function normaliseTime(v: Date | string | undefined): Date {
  if (v === undefined) return new Date();
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) throw new Error("not_before: invalid Date");
    return v;
  }
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`not_before: cannot parse ${JSON.stringify(v)}`);
  }
  return d;
}

/**
 * Idempotent submit. If `idempotency_key` is provided and the
 * (kind, key) tuple already exists, the existing row is returned
 * with `inserted: false`. Otherwise inserts a new row.
 *
 * When `parent_job_id` is provided, the row inherits `depth + 1` and
 * an entry is recorded in `job_children` so the parent's
 * fan-out fan-in machinery can find it.
 */
export async function submitJob(
  engine: Engine,
  input: SubmitJobInput,
): Promise<SubmitJobResult> {
  if (!input.kind || typeof input.kind !== "string") {
    throw new Error("submitJob: `kind` is required");
  }
  const priority =
    typeof input.priority === "number" &&
    input.priority >= 1 &&
    input.priority <= 10
      ? Math.floor(input.priority)
      : 5;
  const maxRetries =
    typeof input.max_retries === "number" && input.max_retries >= 0
      ? Math.floor(input.max_retries)
      : 3;
  const payload = JSON.stringify(input.payload ?? {});
  const nextAttempt = normaliseTime(input.not_before).toISOString();

  return engine.transaction(async (tx) => {
    let parentDepth = 0;
    if (input.parent_job_id) {
      const p = await tx.query<{ depth: number; status: string }>(
        `SELECT depth, status FROM jobs WHERE id = $1`,
        [input.parent_job_id],
      );
      if (p.rows.length === 0) {
        throw new Error(
          `submitJob: parent_job_id ${input.parent_job_id} does not exist`,
        );
      }
      parentDepth = p.rows[0]!.depth;
      // Refuse fan-out from terminal parents -- they're done; new
      // children cannot reach fan-in anyway.
      if (
        p.rows[0]!.status === "succeeded" ||
        p.rows[0]!.status === "failed" ||
        p.rows[0]!.status === "cancelled"
      ) {
        throw new Error(
          `submitJob: parent_job_id ${input.parent_job_id} is terminal (${p.rows[0]!.status})`,
        );
      }
    }
    const depth = parentDepth + (input.parent_job_id ? 1 : 0);
    if (depth > 32) {
      throw new Error(`submitJob: depth ${depth} exceeds the 32-level cap`);
    }

    // Idempotency: handle the (kind, idempotency_key) UNIQUE.
    // TODO(multitenant): the partial UNIQUE is `(kind, idempotency_key)`.
    // When the brain goes multi-tenant the constraint widens to
    // `(tenant_id, kind, idempotency_key)`. Today everything is one
    // tenant so the simpler shape is correct.
    if (input.idempotency_key) {
      const existing = await tx.query<{ id: string; depth: number }>(
        `SELECT id, depth FROM jobs
           WHERE kind = $1 AND idempotency_key = $2`,
        [input.kind, input.idempotency_key],
      );
      if (existing.rows.length > 0) {
        const row = existing.rows[0]!;
        // If a parent was passed and the row's parent is different /
        // missing, link them via job_children so fan-in still works.
        if (input.parent_job_id) {
          await tx.query(
            `INSERT INTO job_children (parent_id, child_id)
             VALUES ($1, $2)
             ON CONFLICT DO NOTHING`,
            [input.parent_job_id, row.id],
          );
        }
        return { id: row.id, inserted: false, depth: row.depth };
      }
    }

    const id = randomUUID();
    await tx.query(
      `INSERT INTO jobs
         (id, kind, payload, status, priority, retry_count, max_retries,
          next_attempt_at, parent_job_id, depth, idempotency_key)
       VALUES ($1, $2, $3::jsonb, 'pending', $4, 0, $5, $6::timestamptz,
               $7, $8, $9)`,
      [
        id,
        input.kind,
        payload,
        priority,
        maxRetries,
        nextAttempt,
        input.parent_job_id ?? null,
        depth,
        input.idempotency_key ?? null,
      ],
    );
    if (input.parent_job_id) {
      await tx.query(
        `INSERT INTO job_children (parent_id, child_id)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [input.parent_job_id, id],
      );
    }
    return { id, inserted: true, depth };
  });
}

export interface ChildSummary {
  child_id: string;
  kind: string;
  status: string;
  created_at: string;
}

export async function listChildren(
  engine: Engine,
  parentId: string,
): Promise<ChildSummary[]> {
  const r = await engine.query<ChildSummary>(
    `SELECT j.id AS child_id, j.kind, j.status,
            j.created_at::text AS created_at
       FROM job_children jc
       JOIN jobs j ON j.id = jc.child_id
       WHERE jc.parent_id = $1
       ORDER BY j.created_at ASC`,
    [parentId],
  );
  return r.rows;
}

export interface InboxRow {
  parent_id: string;
  child_id: string;
  child_status: "succeeded" | "failed" | "cancelled";
  result_excerpt: string | null;
  completed_at: string;
  notified_at: string | null;
}

/**
 * Write a single completion notification. **Write-once on
 * (parent_id, child_id)**: a job can only legally transition into a
 * terminal state once, so we treat the FIRST observation as truth
 * and ignore later writes. This makes the inbox idempotent against
 * worker retries (a crash between "child completed" and
 * "inbox written" replays the same INSERT and is a no-op).
 *
 * `result` is excerpted to 8 KB. Truncation is byte-bounded (UTF-8)
 * so a multi-byte glyph (emoji, non-BMP char) split exactly at the
 * boundary is dropped cleanly rather than corrupting the trailing
 * column value.
 */
export async function writeChildDoneInbox(
  engine: Engine,
  parentId: string,
  childId: string,
  status: "succeeded" | "failed" | "cancelled",
  result: unknown,
): Promise<void> {
  let excerpt: string | null = null;
  if (result !== null && result !== undefined) {
    const serialised =
      typeof result === "string" ? result : JSON.stringify(result);
    // Byte-bounded truncation. `Buffer.from(s,"utf8").slice(0,N)` can
    // land in the middle of a multi-byte sequence; `toString("utf8")`
    // emits replacement chars for the broken tail. We instead truncate
    // and then decode with `fatal: false` and drop the last malformed
    // codepoint.
    const buf = Buffer.from(serialised, "utf8");
    if (buf.length <= 8192) {
      excerpt = serialised;
    } else {
      // Walk back from byte 8192 until we land on a UTF-8 lead byte
      // (0x00-0x7F or 0xC0+). This drops at most 3 trailing bytes.
      let end = 8192;
      while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
      excerpt = buf.subarray(0, end).toString("utf8");
    }
  }
  await engine.query(
    `INSERT INTO child_done_inbox
       (parent_id, child_id, child_status, result_excerpt)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (parent_id, child_id) DO NOTHING`,
    [parentId, childId, status, excerpt],
  );
}

/**
 * Read unread inbox rows for a parent. The default behaviour
 * (`mark_read: true`) marks them as observed so subsequent calls
 * only see new completions. Pass `mark_read: false` for a
 * peek-only path used by tests.
 */
export async function drainDoneInbox(
  engine: Engine,
  parentId: string,
  opts: { mark_read?: boolean } = {},
): Promise<InboxRow[]> {
  const markRead = opts.mark_read !== false;
  const rows = await engine.query<InboxRow>(
    `SELECT parent_id, child_id, child_status, result_excerpt,
            completed_at::text AS completed_at,
            notified_at::text AS notified_at
       FROM child_done_inbox
       WHERE parent_id = $1 AND notified_at IS NULL
       ORDER BY completed_at ASC`,
    [parentId],
  );
  if (markRead && rows.rows.length > 0) {
    await engine.query(
      `UPDATE child_done_inbox
         SET notified_at = NOW()
       WHERE parent_id = $1 AND notified_at IS NULL`,
      [parentId],
    );
  }
  return rows.rows;
}

/**
 * Cancel a job and (optionally) its still-pending descendants. Only
 * touches rows in `pending` -- running children carry on; the worker
 * is responsible for noticing the parent is cancelled and stopping
 * gracefully.
 */
export async function cancelJob(
  engine: Engine,
  jobId: string,
  opts: { cascade?: boolean; reason?: string } = {},
): Promise<{ cancelled_ids: string[] }> {
  const cascade = opts.cascade !== false;
  const reason = opts.reason ?? "cancelled via cancelJob";
  const visited = new Set<string>([jobId]);
  const ids: string[] = [jobId];
  // Bounded cascade. A pathological tree with millions of pending
  // descendants would otherwise blow the ANY($1::text[]) parameter
  // size and the in-process `ids` array. 10_000 is a generous cap
  // for any realistic agent / recipe workload; beyond that the
  // operator must purge the tree directly rather than via cancel.
  const CASCADE_CAP = 10_000;
  return engine.transaction(async (tx) => {
    if (cascade) {
      // Breadth-first walk of pending descendants via job_children.
      // The idempotency-key path in submitJob can re-link an existing
      // job to a new parent, which means `job_children` may contain
      // cycles in pathological cases. `visited` deduplicates so the
      // BFS terminates even on a cyclic graph.
      let frontier = [jobId];
      let safety = 1000;
      while (frontier.length > 0 && safety-- > 0) {
        const next = await tx.query<{ child_id: string }>(
          `SELECT jc.child_id
             FROM job_children jc
             JOIN jobs j ON j.id = jc.child_id
             WHERE jc.parent_id = ANY($1::text[]) AND j.status = 'pending'`,
          [frontier],
        );
        const newIds: string[] = [];
        for (const r of next.rows) {
          if (!visited.has(r.child_id)) {
            visited.add(r.child_id);
            ids.push(r.child_id);
            newIds.push(r.child_id);
            if (ids.length > CASCADE_CAP) {
              throw new Error(
                `cancelJob: cascade exceeds ${CASCADE_CAP} descendants -- ` +
                  `purge the tree directly rather than via cancel`,
              );
            }
          }
        }
        frontier = newIds;
      }
      if (safety <= 0) {
        throw new Error(
          `cancelJob: BFS safety cap hit at 1000 iterations -- ` +
            `job_children may contain a cycle that escaped visited-set ` +
            `dedup`,
        );
      }
    }
    const r = await tx.query<{ id: string }>(
      `UPDATE jobs
         SET status = 'cancelled',
             last_error = $2,
             finished_at = NOW(),
             updated_at = NOW()
       WHERE id = ANY($1::text[]) AND status = 'pending'
       RETURNING id`,
      [ids, reason],
    );
    return { cancelled_ids: r.rows.map((x) => x.id) };
  });
}

export interface JobSummary {
  id: string;
  kind: string;
  status: string;
  priority: number;
  retry_count: number;
  parent_job_id: string | null;
  depth: number;
  idempotency_key: string | null;
  created_at: string;
  updated_at: string;
}

export interface ListJobsOptions {
  status?: string;
  kind?: string;
  parent_job_id?: string;
  since?: Date | string;
  limit?: number;
}

export async function listJobs(
  engine: Engine,
  opts: ListJobsOptions = {},
): Promise<JobSummary[]> {
  const params: unknown[] = [];
  const where: string[] = [];
  if (opts.status) {
    params.push(opts.status);
    where.push(`status = $${params.length}`);
  }
  if (opts.kind) {
    params.push(opts.kind);
    where.push(`kind = $${params.length}`);
  }
  if (opts.parent_job_id !== undefined) {
    params.push(opts.parent_job_id);
    where.push(`parent_job_id = $${params.length}`);
  }
  if (opts.since !== undefined) {
    params.push(normaliseTime(opts.since).toISOString());
    where.push(`created_at >= $${params.length}::timestamptz`);
  }
  const limit =
    typeof opts.limit === "number" && opts.limit >= 1 && opts.limit <= 1000
      ? Math.floor(opts.limit)
      : 100;
  params.push(limit);
  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const r = await engine.query<JobSummary>(
    `SELECT id, kind, status, priority, retry_count,
            parent_job_id, depth, idempotency_key,
            created_at::text AS created_at,
            updated_at::text AS updated_at
       FROM jobs
       ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${params.length}`,
    params,
  );
  return r.rows;
}

export interface JobDetail extends JobSummary {
  payload: Record<string, unknown>;
  /**
   * Result of the handler's last successful run, or null if not
   * succeeded yet. Typed as `unknown` because a handler may legally
   * return a string, number, array, or null -- coercing to object
   * would silently drop those shapes. Callers that need a strict
   * type should validate at the boundary.
   */
  result: unknown;
  last_error: string | null;
  next_attempt_at: string;
  started_at: string | null;
  finished_at: string | null;
  children: ChildSummary[];
  inbox_unread: number;
}

export async function getJob(
  engine: Engine,
  jobId: string,
): Promise<JobDetail | null> {
  const r = await engine.query<{
    id: string;
    kind: string;
    payload: Record<string, unknown> | string;
    status: string;
    priority: number;
    retry_count: number;
    parent_job_id: string | null;
    depth: number;
    idempotency_key: string | null;
    next_attempt_at: string;
    result: Record<string, unknown> | string | null;
    last_error: string | null;
    started_at: string | null;
    finished_at: string | null;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT id, kind, payload, status, priority, retry_count,
            parent_job_id, depth, idempotency_key,
            next_attempt_at::text AS next_attempt_at,
            result, last_error,
            started_at::text AS started_at,
            finished_at::text AS finished_at,
            created_at::text AS created_at,
            updated_at::text AS updated_at
       FROM jobs
       WHERE id = $1`,
    [jobId],
  );
  if (r.rows.length === 0) return null;
  const row = r.rows[0]!;
  const parsePayload = (p: typeof row.payload): Record<string, unknown> => {
    if (typeof p === "string") {
      try {
        return JSON.parse(p) as Record<string, unknown>;
      } catch {
        return {};
      }
    }
    return p ?? {};
  };
  const parseResult = (p: typeof row.result): unknown => {
    if (p === null || p === undefined) return null;
    if (typeof p === "string") {
      try {
        return JSON.parse(p);
      } catch {
        // Stored value isn't valid JSON; pass through the raw string
        // so the operator can debug rather than silently see `null`.
        return p;
      }
    }
    return p;
  };
  const children = await listChildren(engine, jobId);
  const unread = await engine.query<{ c: number }>(
    `SELECT COUNT(*)::int AS c FROM child_done_inbox
       WHERE parent_id = $1 AND notified_at IS NULL`,
    [jobId],
  );
  return {
    id: row.id,
    kind: row.kind,
    payload: parsePayload(row.payload),
    status: row.status,
    priority: row.priority,
    retry_count: row.retry_count,
    parent_job_id: row.parent_job_id,
    depth: row.depth,
    idempotency_key: row.idempotency_key,
    next_attempt_at: row.next_attempt_at,
    result: parseResult(row.result),
    last_error: row.last_error,
    started_at: row.started_at,
    finished_at: row.finished_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    children,
    inbox_unread: unread.rows[0]?.c ?? 0,
  };
}
