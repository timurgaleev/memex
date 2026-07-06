/**
 * Job queue types — the shape of rows + handler signatures.
 */

export type JobStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface JobRow {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  status: JobStatus;
  priority: number;
  retryCount: number;
  maxRetries: number;
  nextAttemptAt: Date;
  quietHoursSkip: boolean;
  lastError: string | null;
  result: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  /** Wall-clock until which this row's `running` claim is valid. */
  lockUntil: Date | null;
  /** Number of times handleStalled has requeued this row. */
  stallCount: number;
  /** Cap on stalls before terminal-fail. */
  maxStalled: number;
  /**
   * Hard per-job wall-clock cap (ms) the worker races the handler against; on
   * exceed the job is dead-lettered (terminal fail). NULL = use the worker's
   * process-wide default (off unless configured).
   */
  timeoutMs: number | null;
  /** Structured handler-reported progress (migration 083). NULL until set. */
  progress: Record<string, unknown> | null;
  /** Accumulated LLM input tokens for this job (migration 083). */
  tokensInput: number;
  /** Accumulated LLM output tokens for this job (migration 083). */
  tokensOutput: number;
  /** Accumulated prompt-cache-read tokens for this job (migration 083). */
  tokensCacheRead: number;
  /** Accumulated dollar estimate of paid calls made by this job (migration 083). */
  costUsd: number;
}

/** Incremental token/cost usage a handler reports mid-run. All fields add. */
export interface JobUsageDelta {
  tokensInput?: number;
  tokensOutput?: number;
  tokensCacheRead?: number;
  costUsd?: number;
}

/**
 * Handler signature. Throw to fail; return any JSON-serialisable value
 * (or undefined) to succeed. The queue persists the return value as
 * `jobs.result`.
 *
 * `updateProgress` / `recordUsage` are provided by the Worker (optional so
 * tests can invoke handlers with a bare `{ job }` context): progress replaces
 * the row's `progress` JSONB, usage deltas accumulate onto the token/cost
 * columns. Both are running-status-gated no-ops after the claim is lost.
 */
export type JobHandler = (
  payload: Record<string, unknown>,
  ctx: {
    job: JobRow;
    updateProgress?: (progress: Record<string, unknown>) => Promise<boolean>;
    recordUsage?: (usage: JobUsageDelta) => Promise<boolean>;
  },
) => Promise<Record<string, unknown> | void>;

export interface EnqueueInput {
  kind: string;
  payload?: Record<string, unknown>;
  /** Stable id — pass to enforce idempotency. Random UUID if omitted. */
  id?: string;
  /** 1 (highest) – 10 (lowest). Default 5. */
  priority?: number;
  maxRetries?: number;
  /** Defer first attempt until this time. Default NOW. */
  runAt?: Date;
  /** When true, the worker won't claim this job during quiet hours. */
  quietHoursSkip?: boolean;
  /**
   * Hard wall-clock cap (ms, > 0) for this job's handler. On exceed the worker
   * dead-letters it (terminal, no retry). Omit to use the worker default.
   */
  timeoutMs?: number;
}
