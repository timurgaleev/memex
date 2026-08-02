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
import type { EnqueueInput, JobRow, JobStatus, JobUsageDelta } from "./types.ts";

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
  timeout_ms: number | null;
  progress: Record<string, unknown> | string | null;
  tokens_input: number | string;
  tokens_output: number | string;
  tokens_cache_read: number | string;
  cost_usd: number | string;
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
    timeoutMs: r.timeout_ms ?? null,
    progress: toJson<Record<string, unknown>>(r.progress),
    tokensInput: toNum(r.tokens_input),
    tokensOutput: toNum(r.tokens_output),
    tokensCacheRead: toNum(r.tokens_cache_read),
    // NUMERIC comes back as a string from postgres-js.
    costUsd: toNum(r.cost_usd),
  };
}

function toNum(v: number | string | null | undefined): number {
  if (v === null || v === undefined) return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

const SELECT_COLS =
  "id, kind, payload, status, priority, retry_count, max_retries, next_attempt_at, quiet_hours_skip, last_error, result, created_at, updated_at, started_at, finished_at, lock_until, stall_count, max_stalled, timeout_ms, progress, tokens_input, tokens_output, tokens_cache_read, cost_usd";

const DEFAULT_LOCK_SECONDS = 300; // 5 min — comfortably bigger than any
                                  // realistic job duration we run today.
/** Postgres INTEGER ceiling for `jobs.timeout_ms` (~24.8 days). */
const MAX_TIMEOUT_MS = 2_147_483_647;

export interface ClaimOptions {
  /** Override "now" (tests). Defaults to new Date(). */
  now?: Date;
  /** Override the quiet-hours window (tests). */
  quietWindow?: QuietWindow;
  /** Seconds the running claim is valid for before stall detection requeues it. */
  lockSeconds?: number;
  /**
   * Restrict the claim to these kinds. Lets an auxiliary worker (e.g. the
   * jobs smoke self-test) process only its own kinds without draining the
   * live queue. Omit for the normal any-kind claim.
   */
  kinds?: string[];
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

export interface PruneOptions {
  /** Delete rows whose `updated_at` is before this. Default: 30 days ago. */
  olderThan?: Date;
  /** Terminal statuses to prune. Default: succeeded + failed + cancelled. */
  statuses?: JobStatus[];
  /** Count the matching rows without deleting them. */
  dryRun?: boolean;
}

export interface FailOptions {
  baseMs?: number;
  maxMs?: number;
  /** Override "now" for backoff scheduling (tests). */
  now?: Date;
  /**
   * Dead-letter: force a terminal `failed` regardless of remaining retries.
   * Used for a hard per-job timeout, where retrying would just wedge the worker
   * again. retry_count is still bumped for the record.
   */
  terminal?: boolean;
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
    let timeoutMs: number | null = null;
    if (input.timeoutMs !== undefined) {
      if (
        !Number.isInteger(input.timeoutMs) ||
        input.timeoutMs <= 0 ||
        input.timeoutMs > MAX_TIMEOUT_MS
      ) {
        throw new Error(
          `Queue.enqueue: timeoutMs must be a positive integer <= ${MAX_TIMEOUT_MS} (got ${input.timeoutMs})`,
        );
      }
      timeoutMs = input.timeoutMs;
    }
    const r = await this.engine.query<RawJobRow>(
      `INSERT INTO jobs (id, kind, payload, priority, max_retries, next_attempt_at, quiet_hours_skip, timeout_ms)
       VALUES ($1, $2, $3::text::jsonb, $4, $5, COALESCE($6, NOW()), $7, $8)
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
        timeoutMs,
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
    const params: unknown[] = [now, lockUntil];
    let kindClause = "";
    if (opts.kinds !== undefined && opts.kinds.length > 0) {
      params.push(opts.kinds);
      kindClause = `AND kind = ANY($${params.length}::text[])`;
    }
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
             ${kindClause}
           ORDER BY priority ASC, next_attempt_at ASC
           LIMIT 1
           FOR UPDATE SKIP LOCKED
        )
        RETURNING ${SELECT_COLS}`,
      params,
    );
    return r.rows[0] ? rowToJob(r.rows[0]) : null;
  }

  /**
   * Extend a running job's `lock_until`. The worker calls this when a job's
   * hard `timeout_ms` is longer than the claim lock, so the stall sweep can't
   * requeue the row out from under an in-flight handler before its timeout
   * fires. Returns true if a `running` row was extended, false if the row is no
   * longer `running` (claim already lost) so the caller can abort the attempt.
   */
  async extendLock(id: string, lockUntil: Date): Promise<boolean> {
    const r = await this.engine.query<{ id: string }>(
      `UPDATE jobs SET lock_until = $2, updated_at = NOW()
        WHERE id = $1 AND status = 'running'
        RETURNING id`,
      [id, lockUntil],
    );
    return r.rows.length > 0;
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
              result = $2::text::jsonb,
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
    if (opts.terminal || nextRetry > job.maxRetries) {
      const r = await this.engine.query<RawJobRow>(
        `UPDATE jobs
            SET status = 'failed',
                retry_count = $2,
                last_error = $3,
                finished_at = NOW(),
                updated_at = NOW(),
                lock_until = NULL
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

  /**
   * Reset a failed/cancelled job to pending so the worker picks it up.
   *
   * An explicit retry is the operator asserting "run this fresh", so the
   * attempt budgets go back to zero too. A row that reached `failed` did so
   * precisely because `retry_count` passed `max_retries` (or `stall_count`
   * passed `max_stalled`) — leaving those at their exhausted values means the
   * very next ordinary failure or lock expiry terminal-fails the job again
   * immediately, and retry does nothing for the case it exists for.
   * `last_error` is cleared with them: it belongs to the attempt the operator
   * just decided to discard.
   */
  async retry(id: string): Promise<JobRow | null> {
    const r = await this.engine.query<RawJobRow>(
      `UPDATE jobs
          SET status = 'pending',
              next_attempt_at = NOW(),
              started_at = NULL,
              finished_at = NULL,
              retry_count = 0,
              stall_count = 0,
              last_error = NULL,
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

  /**
   * Replace a running job's structured progress. Status-gated on `running`
   * (no lock token in memex's single-active-worker model): a late write after
   * the claim is lost or the job finished is a no-op. Returns true when a row
   * was updated.
   */
  async updateProgress(
    id: string,
    progress: Record<string, unknown>,
  ): Promise<boolean> {
    const r = await this.engine.query<{ id: string }>(
      `UPDATE jobs SET progress = $2::text::jsonb, updated_at = NOW()
        WHERE id = $1 AND status = 'running'
        RETURNING id`,
      [id, JSON.stringify(progress)],
    );
    return r.rows.length > 0;
  }

  /**
   * Accumulate token/cost usage onto a running job's counters (migration 083).
   * Deltas add; negative or non-finite inputs are clamped to 0. Running-gated
   * like updateProgress. Returns true when a row was updated.
   */
  async recordUsage(id: string, usage: JobUsageDelta): Promise<boolean> {
    const clamp = (v: number | undefined): number =>
      v !== undefined && Number.isFinite(v) && v > 0 ? v : 0;
    const inTok = Math.trunc(clamp(usage.tokensInput));
    const outTok = Math.trunc(clamp(usage.tokensOutput));
    const cacheTok = Math.trunc(clamp(usage.tokensCacheRead));
    const cost = clamp(usage.costUsd);
    if (inTok === 0 && outTok === 0 && cacheTok === 0 && cost === 0) {
      return false;
    }
    const r = await this.engine.query<{ id: string }>(
      `UPDATE jobs
          SET tokens_input = tokens_input + $2,
              tokens_output = tokens_output + $3,
              tokens_cache_read = tokens_cache_read + $4,
              cost_usd = cost_usd + $5,
              updated_at = NOW()
        WHERE id = $1 AND status = 'running'
        RETURNING id`,
      [id, inTok, outTok, cacheTok, cost],
    );
    return r.rows.length > 0;
  }

  /**
   * Delete a single job row. Terminal statuses only — a pending/running row
   * must be cancelled first so the worker can't complete into a void.
   */
  async remove(id: string): Promise<boolean> {
    const r = await this.engine.query<{ id: string }>(
      `DELETE FROM jobs
        WHERE id = $1 AND status IN ('succeeded', 'failed', 'cancelled')
        RETURNING id`,
      [id],
    );
    return r.rows.length > 0;
  }

  /**
   * Delete old terminal jobs (the table otherwise grows unbounded). Defaults:
   * every terminal status, older than 30 days by `updated_at`. Returns the
   * number of rows deleted — or, with `dryRun`, the number that would be.
   */
  async prune(opts: PruneOptions = {}): Promise<number> {
    const statuses = opts.statuses ?? ["succeeded", "failed", "cancelled"];
    const terminal: JobStatus[] = ["succeeded", "failed", "cancelled"];
    for (const s of statuses) {
      if (!terminal.includes(s)) {
        throw new Error(`Queue.prune: '${s}' is not a terminal status`);
      }
    }
    if (statuses.length === 0) return 0;
    const olderThan =
      opts.olderThan ?? new Date(Date.now() - 30 * 86_400_000);
    if (opts.dryRun) {
      const r = await this.engine.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM jobs
          WHERE status = ANY($1::text[]) AND updated_at < $2`,
        [statuses, olderThan],
      );
      return r.rows[0]?.n ?? 0;
    }
    const r = await this.engine.query<{ id: string }>(
      `DELETE FROM jobs
        WHERE status = ANY($1::text[]) AND updated_at < $2
        RETURNING id`,
      [statuses, olderThan],
    );
    return r.rows.length;
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
