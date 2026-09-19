/**
 * Connection-retry primitive for bulk DB writes. A transient RDS socket reset
 * or a brief "too many clients" blip during a batch write (cycle re-embed,
 * indexer transaction) should retry with backoff rather than drop the batch and
 * lean on the coarser job/backfill resume.
 *
 * Deliberately small: statement/lock timeouts are NOT retryable (retrying a
 * query that already timed out just burns the budget again — those need
 * batch-halving, out of scope here). PGLite errors never match, so on the
 * embedded engine withRetry is a transparent passthrough.
 *
 * `withDeadlockRetry` is the one other envelope here: a deadlock victim is not a
 * connection failure, and what it retries is a whole transaction, not a query.
 */

import type { Engine } from "./engine/interface.ts";

type Jitter = "none" | "full" | "decorrelated";

export interface RetryOptions {
  maxRetries?: number;
  delayMs?: number;
  delayMaxMs?: number;
  jitter?: Jitter;
  rng?: () => number;
  onRetry?: (attempt: number, err: unknown) => void;
}

/** Bulk-write retry envelope (~12s across 3 tries). */
export const BULK_RETRY_OPTS: RetryOptions = {
  maxRetries: 3,
  delayMs: 1000,
  delayMaxMs: 10_000,
  jitter: "decorrelated",
};

function errCode(err: unknown): string {
  if (err && typeof err === "object" && "code" in err) {
    return String((err as { code: unknown }).code ?? "");
  }
  return "";
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err ?? "");
}

/**
 * True for a transient CONNECTION error worth retrying. Excludes
 * statement_timeout (57014) and lock_timeout (55P03) — those are not
 * connection failures and a blind retry just repeats the wait.
 */
export function isRetryableConnError(err: unknown): boolean {
  const code = errCode(err);
  if (code === "57014" || code === "55P03") return false; // statement/lock timeout
  if (code.startsWith("08")) return true; // Class 08 — connection exception
  if (
    code === "CONNECTION_ENDED" ||
    code === "ECONNRESET" ||
    code === "53300" // too_many_connections
  ) {
    return true;
  }
  return /ECONNRESET|Connection terminated unexpectedly|connection.*closed|server closed the connection|could not connect to server|the database system is starting up|too many clients already|remaining connection slots are reserved/i.test(
    errMessage(err),
  );
}

/**
 * SQLSTATE 57014: query_canceled / statement_timeout. Postgres signals this
 * when a statement exceeds `statement_timeout`. Deliberately NOT part of
 * {@link isRetryableConnError} (a bulk write shouldn't blindly re-run a query
 * that timed out) — the migration runner opts into it explicitly, because a
 * long `ADD COLUMN` backfill or index build can trip a transient timeout that
 * a re-attempt clears.
 */
export function isStatementTimeoutError(err: unknown): boolean {
  if (errCode(err) === "57014") return true;
  return /statement_timeout|canceling statement due to statement timeout/i.test(
    errMessage(err),
  );
}

/** SQLSTATE 40P01: Postgres aborted this transaction to break a deadlock. */
export function isDeadlockError(err: unknown): boolean {
  if (errCode(err) === "40P01") return true;
  return /deadlock detected/i.test(errMessage(err));
}

export interface DeadlockRetryOptions {
  /** Total attempts, including the first. */
  attempts?: number;
  rng?: () => number;
  onRetry?: (attempt: number, err: unknown) => void;
}

/**
 * Re-run a transaction Postgres chose as a deadlock victim.
 *
 * The withdrawal protocol (migration 112) has to sweep duplicate claims on BOTH
 * sides of its per-source advisory lock — before it, so no committed row lock is
 * awaited while holding the lock, and again under it, for an insert that raced
 * past its trigger check. Two such writers (a forget and a merge, a forget and a
 * fence rebuild) therefore take fact row locks and the advisory lock in an order
 * no single global rule can fix, and Postgres resolves the rare cycle by
 * aborting one side. Re-running the whole transaction off a clean rollback is
 * cheaper than surfacing 40P01 mid-merge.
 *
 * Only for a closure whose every effect is a DB write inside the transaction: a
 * retry repeats it. PGLite is single-connection, so there it never fires.
 */
export async function withDeadlockRetry<T>(
  fn: () => Promise<T>,
  opts: DeadlockRetryOptions = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const rng = opts.rng ?? Math.random;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= attempts || !isDeadlockError(err)) throw err;
      opts.onRetry?.(attempt, err);
      // A few ms of jitter, so two victims of the same cycle do not re-collide
      // in lockstep.
      await new Promise((r) => setTimeout(r, Math.round(rng() * 25 * attempt)));
    }
  }
}

/**
 * `engine.transaction`, re-run when Postgres picks it as a deadlock victim.
 * The call site reads as an ordinary transaction, which is the point: every
 * writer that takes the migration 112 withdraw lock goes through this.
 */
export function deadlockSafeTransaction<T>(
  engine: Engine,
  fn: (tx: Engine) => Promise<T>,
  opts: DeadlockRetryOptions = {},
): Promise<T> {
  return withDeadlockRetry(() => engine.transaction(fn), opts);
}

/** Next backoff delay (ms), bounded by delayMaxMs. Pure. */
export function computeNextDelay(
  jitter: Jitter,
  attempt: number,
  prevDelay: number,
  base: number,
  maxDelay: number,
  rng: () => number = Math.random,
): number {
  if (jitter === "none") return Math.min(base * 2 ** attempt, maxDelay);
  if (jitter === "full") return Math.min(rng() * base * 2 ** attempt, maxDelay);
  // decorrelated: random between base and prevDelay*3
  const hi = Math.min(prevDelay * 3, maxDelay);
  return Math.min(base + rng() * Math.max(0, hi - base), maxDelay);
}

function resolveMaxRetries(fallback: number): number {
  const raw = process.env.MEMEX_BULK_MAX_RETRIES;
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

/**
 * Run `fn`, retrying on a transient connection error with decorrelated backoff.
 * A non-retryable error throws on the first failure. `MEMEX_BULK_MAX_RETRIES=0`
 * disables retries (debugging kill switch).
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const maxRetries = resolveMaxRetries(opts.maxRetries ?? 3);
  const base = opts.delayMs ?? 1000;
  const maxDelay = opts.delayMaxMs ?? 10_000;
  const jitter = opts.jitter ?? "decorrelated";
  const rng = opts.rng ?? Math.random;
  let delay = base;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= maxRetries || !isRetryableConnError(err)) throw err;
      opts.onRetry?.(attempt + 1, err);
      delay = computeNextDelay(jitter, attempt, delay, base, maxDelay, rng);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}
