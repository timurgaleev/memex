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
}

/**
 * Handler signature. Throw to fail; return any JSON-serialisable value
 * (or undefined) to succeed. The queue persists the return value as
 * `jobs.result`.
 */
export type JobHandler = (
  payload: Record<string, unknown>,
  ctx: { job: JobRow },
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
}
