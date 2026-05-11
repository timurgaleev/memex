/**
 * Job queue — durable CRUD + atomic claim for memex jobs.
 *
 * The claim path uses `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP
 * LOCKED LIMIT 1) RETURNING *` so two concurrent workers can't pick
 * the same row. PGLite is single-connection so concurrency is moot
 * there; this exists for the postgres-js production engine.
 */
import { randomUUID } from "node:crypto";
import type { Engine } from "../engine/interface.ts";
import { backoffMs } from "./backoff.ts";
import { inQuietHours, type QuietWindow } from "./quiet-hours.ts";
import type { EnqueueInput, JobRow, JobStatus } from "./types.ts";

interface RawJobRow {
  id: string;
  kind: string;
  payload: Record<string, unknown> | string;
  status: JobStatus;
  priority: number;
  retry_count: number;
  max_retries: number;
  next_attempt_at: string | Date;
  quiet_hours_skip: boolean;
  last_error: string | null;
  result: Record<string, unknown> | string | null;
  created_at: string | Date;
  updated_at: string | Date;
  started_at: string | Date | null;
  finished_at: string | Date | null;
  lock_until: string | Date | null;
  stall_count: number;
  max_stalled: number;
}

function toDate(v: string | Date): Date {
  return v instanceof Date ? v : new Date(v);
}

function toJson<T>(v: T | string | null): T | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") {
    try {
      return JSON.parse(v) as T;
    } catch {
      return null;
    }
  }
  return v as T;
}

function rowToJob(r: RawJobRow): JobRow {
  return {
    id: r.id,
    kind: r.kind,
    payload: (toJson<Record<string, unknown>>(r.payload) ?? {}) as Record<
      string,
      unknown
    >,
    status: r.status,
    priority: r.priority,
    retryCount: r.retry_count,
    maxRetries: r.max_retries,
    nextAttemptAt: toDate(r.next_attempt_at),
    quietHoursSkip: r.quiet_hours_skip,
    lastError: r.last_error,
    result: toJson<Record<string, unknown>>(r.result),
    createdAt: toDate(r.created_at),
    updatedAt: toDate(r.updated_at),
    startedAt: r.started_at ? toDate(r.started_at) : null,
    finishedAt: r.finished_at ? toDate(r.finished_at) : null,
    lockUntil: r.lock_until ? toDate(r.lock_until) : null,
    stallCount: r.stall_count,
    maxStalled: r.max_stalled,
  };
}

const SELECT_COLS =
  "id, kind, payload, status, priority, retry_count, max_retries, next_attempt_at, quiet_hours_skip, last_error, result, created_at, updated_at, started_at, finished_at, lock_until, stall_count, max_stalled";

const DEFAULT_LOCK_SECONDS = 300; // 5 min — comfortably bigger than any
                                  // realistic job duration we run today.

export interface ClaimOptions {
  /** Override "now" (tests). Defaults to new Date(). */
  now?: Date;
  /** Override the quiet-hours window (tests). */
  quietWindow?: QuietWindow;
  /** Seconds the running claim is valid for before stall detection requeues it. */
  lockSeconds?: number;
}

export interface HandleStalledOptions {
  /** Override "now" (tests). */
  now?: Date;
}

export interface HandleStalledResult {
  requeued: number;
  terminallyFailed: number;
  ids: string[];
}

export interface ListOptions {
  status?: JobStatus | JobStatus[];
  kind?: string;
  /** Default 50, max 500. */
  limit?: number;
}

export interface FailOptions {
  baseMs?: number;
  maxMs?: number;
  /** Override "now" for backoff scheduling (tests). */
  now?: Date;
}

export class Queue {
  constructor(private readonly engine: Engine) {}

  async enqueue(input: EnqueueInput): Promise<JobRow> {
    if (!input.kind) throw new Error("Queue.enqueue: kind is required");
    const id = input.id ?? randomUUID();
    const priority = input.priority ?? 5;
    if (!Number.isInteger(priority) || priority < 1 || priority > 10) {
      throw new Error(`Queue.enqueue: priority must be 1-10 (got ${priority})`);
    }
    const maxRetries = input.maxRetries ?? 3;
    if (!Number.isInteger(maxRetries) || maxRetries < 0) {
      throw new Error(
        `Queue.enqueue: maxRetries must be >= 0 (got ${maxRetries})`,
      );
    }
    const r = await this.engine.query<RawJobRow>(
      `INSERT INTO jobs (id, kind, payload, priority, max_retries, next_attempt_at, quiet_hours_skip)
       VALUES ($1, $2, $3::jsonb, $4, $5, COALESCE($6, NOW()), $7)
       ON CONFLICT (id) DO NOTHING
       RETURNING ${SELECT_COLS}`,
      [
        id,
        input.kind,
        JSON.stringify(input.payload ?? {}),
        priority,
        maxRetries,
        input.runAt ?? null,
        input.quietHoursSkip ?? false,
      ],
    );
    if (r.rows[0]) return rowToJob(r.rows[0]);
    // Idempotent insert — caller passed an existing id. Return the existing row.
    const existing = await this.get(id);
    if (!existing) {
      throw new Error(
        `Queue.enqueue: insert reported conflict but row ${id} not found`,
      );
    }
    return existing;
  }

  async get(id: string): Promise<JobRow | null> {
    const r = await this.engine.query<RawJobRow>(
      `SELECT ${SELECT_COLS} FROM jobs WHERE id = $1`,
      [id],
    );
    return r.rows[0] ? rowToJob(r.rows[0]) : null;
  }

  /**
   * Atomically claim the highest-priority due job, marking it `running`
   * with a lock_until horizon. Returns null if nothing is due (or
   * everything due is gated by quiet hours).
   *
   * The lock_until field is what `handleStalled()` watches: a worker
   * that dies between claim and complete leaves a stale `running` row,
   * but once `lock_until` passes, the row gets requeued.
   */
  async claim(opts: ClaimOptions = {}): Promise<JobRow | null> {
    const now = opts.now ?? new Date();
    const lockSeconds = opts.lockSeconds ?? DEFAULT_LOCK_SECONDS;
    const lockUntil = new Date(now.getTime() + lockSeconds * 1000);
    const quiet = inQuietHours(now, opts.quietWindow);
    const quietClause = quiet ? "AND quiet_hours_skip = false" : "";
    const r = await this.engine.query<RawJobRow>(
      `UPDATE jobs
          SET status = 'running',
              started_at = $1,
              updated_at = $1,
              lock_until = $2
        WHERE id = (
          SELECT id FROM jobs
           WHERE status = 'pending'
             AND next_attempt_at <= $1
             ${quietClause}
           ORDER BY priority ASC, next_attempt_at ASC
           LIMIT 1
           FOR UPDATE SKIP LOCKED
        )
        RETURNING ${SELECT_COLS}`,
      [now, lockUntil],
    );
    return r.rows[0] ? rowToJob(r.rows[0]) : null;
  }

  /**
   * Find rows whose `lock_until` has passed and either requeue them
   * (stall_count++) or mark them terminally failed when stall_count
   * exceeds max_stalled. Designed to run periodically inside the
   * worker loop, before each `claim`.
   */
  async handleStalled(
    opts: HandleStalledOptions = {},
  ): Promise<HandleStalledResult> {
    const now = opts.now ?? new Date();
    // Fetch candidates, then update each — we need per-row branching
    // (stall_count vs max_stalled) which a single UPDATE can't express
    // cleanly across PGLite + Postgres. Volume is low (zero in healthy
    // operation; bounded by worker count when not).
    const rows = await this.engine.query<{
      id: string;
      stall_count: number;
      max_stalled: number;
    }>(
      `SELECT id, stall_count, max_stalled
         FROM jobs
        WHERE status = 'running'
          AND lock_until IS NOT NULL
          AND lock_until < $1
        ORDER BY lock_until ASC`,
      [now],
    );
    const result: HandleStalledResult = {
      requeued: 0,
      terminallyFailed: 0,
      ids: [],
    };
    for (const row of rows.rows) {
      const nextStall = row.stall_count + 1;
      if (nextStall > row.max_stalled) {
        await this.engine.query(
          `UPDATE jobs
              SET status = 'failed',
                  stall_count = $2,
                  last_error = 'stall budget exhausted',
                  finished_at = $3,
                  updated_at = $3,
                  lock_until = NULL
            WHERE id = $1 AND status = 'running'`,
          [row.id, nextStall, now],
        );
        result.terminallyFailed++;
      } else {
        await this.engine.query(
          `UPDATE jobs
              SET status = 'pending',
                  stall_count = $2,
                  last_error = 'requeued after stall',
                  next_attempt_at = $3,
                  started_at = NULL,
                  lock_until = NULL,
                  updated_at = $3
            WHERE id = $1 AND status = 'running'`,
          [row.id, nextStall, now],
        );
        result.requeued++;
      }
      result.ids.push(row.id);
    }
    return result;
  }

  /**
   * Mark a `running` job as `succeeded`. Status-gated so a stray
   * `complete()` after a `cancel()` (or a duplicate worker tick) can't
   * silently overwrite the cancelled-or-already-finished row.
   */
  async complete(
    id: string,
    result?: Record<string, unknown>,
  ): Promise<JobRow | null> {
    const r = await this.engine.query<RawJobRow>(
      `UPDATE jobs
          SET status = 'succeeded',
              result = $2::jsonb,
              finished_at = NOW(),
              updated_at = NOW(),
              last_error = NULL,
              lock_until = NULL
        WHERE id = $1 AND status = 'running'
        RETURNING ${SELECT_COLS}`,
      [id, JSON.stringify(result ?? {})],
    );
    return r.rows[0] ? rowToJob(r.rows[0]) : null;
  }

  /**
   * Mark the in-flight job as failed. If retry budget remains, schedule
   * the next attempt via exponential backoff; otherwise terminal-fail.
   *
   * Status-gated on `running` — a `fail()` racing a `cancel()` is a no-op
   * (returns null) so the cancelled row isn't reanimated into pending.
   */
  async fail(
    id: string,
    error: string,
    opts: FailOptions = {},
  ): Promise<JobRow | null> {
    const job = await this.get(id);
    if (!job) return null;
    if (job.status !== "running") return null;
    const nextRetry = job.retryCount + 1;
    if (nextRetry > job.maxRetries) {
      const r = await this.engine.query<RawJobRow>(
        `UPDATE jobs
            SET status = 'failed',
                retry_count = $2,
                last_error = $3,
                finished_at = NOW(),
                updated_at = NOW()
          WHERE id = $1 AND status = 'running'
          RETURNING ${SELECT_COLS}`,
        [id, nextRetry, error],
      );
      return r.rows[0] ? rowToJob(r.rows[0]) : null;
    }
    const delay = backoffMs(nextRetry - 1, {
      ...(opts.baseMs !== undefined ? { baseMs: opts.baseMs } : {}),
      ...(opts.maxMs !== undefined ? { maxMs: opts.maxMs } : {}),
    });
    const now = opts.now ?? new Date();
    const next = new Date(now.getTime() + delay);
    const r = await this.engine.query<RawJobRow>(
      `UPDATE jobs
          SET status = 'pending',
              retry_count = $2,
              last_error = $3,
              next_attempt_at = $4,
              started_at = NULL,
              updated_at = NOW()
        WHERE id = $1 AND status = 'running'
        RETURNING ${SELECT_COLS}`,
      [id, nextRetry, error, next],
    );
    return r.rows[0] ? rowToJob(r.rows[0]) : null;
  }

  async cancel(id: string): Promise<JobRow | null> {
    const r = await this.engine.query<RawJobRow>(
      `UPDATE jobs
          SET status = 'cancelled',
              finished_at = NOW(),
              updated_at = NOW(),
              lock_until = NULL
        WHERE id = $1 AND status IN ('pending', 'running')
        RETURNING ${SELECT_COLS}`,
      [id],
    );
    return r.rows[0] ? rowToJob(r.rows[0]) : null;
  }

  /** Reset a failed/cancelled job to pending so the worker picks it up. */
  async retry(id: string): Promise<JobRow | null> {
    const r = await this.engine.query<RawJobRow>(
      `UPDATE jobs
          SET status = 'pending',
              next_attempt_at = NOW(),
              started_at = NULL,
              finished_at = NULL,
              updated_at = NOW()
        WHERE id = $1 AND status IN ('failed', 'cancelled')
        RETURNING ${SELECT_COLS}`,
      [id],
    );
    return r.rows[0] ? rowToJob(r.rows[0]) : null;
  }

  async list(opts: ListOptions = {}): Promise<JobRow[]> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
    const wheres: string[] = [];
    const params: unknown[] = [];
    if (opts.status) {
      const arr = Array.isArray(opts.status) ? opts.status : [opts.status];
      params.push(arr);
      wheres.push(`status = ANY($${params.length}::text[])`);
    }
    if (opts.kind) {
      params.push(opts.kind);
      wheres.push(`kind = $${params.length}`);
    }
    const whereSql = wheres.length === 0 ? "" : `WHERE ${wheres.join(" AND ")}`;
    params.push(limit);
    const r = await this.engine.query<RawJobRow>(
      `SELECT ${SELECT_COLS}
         FROM jobs
         ${whereSql}
        ORDER BY created_at DESC
        LIMIT $${params.length}`,
      params,
    );
    return r.rows.map(rowToJob);
  }

  async stats(): Promise<Record<JobStatus, number>> {
    const r = await this.engine.query<{ status: JobStatus; n: number }>(
      `SELECT status, COUNT(*)::int AS n FROM jobs GROUP BY status`,
    );
    const out: Record<JobStatus, number> = {
      pending: 0,
      running: 0,
      succeeded: 0,
      failed: 0,
      cancelled: 0,
    };
    for (const row of r.rows) out[row.status] = row.n;
    return out;
  }
}
