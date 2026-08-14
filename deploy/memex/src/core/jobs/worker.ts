/**
 * Job worker — claims due jobs and dispatches them to handlers.
 *
 * Designed to run in-process (single timer; not multi-thread). For
 * scale-out we'd add a process-id column + heartbeat; the queue's atomic
 * claim already supports multiple workers against the same Postgres
 * because of `FOR UPDATE SKIP LOCKED`.
 *
 * Lifecycle:
 *   const worker = new Worker(queue);
 *   await worker.start();      // schedules a recurring poll
 *   ...
 *   await worker.stop();       // waits for the in-flight job, then exits
 */
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { getHandler } from "./handlers.ts";
import type { Queue } from "./queue.ts";
import type { JobRow } from "./types.ts";
import type { Engine } from "../engine/interface.ts";
import {
  acquireWorkerLock,
  heartbeatWorkerLock,
  releaseWorkerLock,
  DEFAULT_WORKER_LOCK_ID,
} from "./worker-lock.ts";

/** Queue.claim's default lock seconds — mirrored so lock-vs-timeout math agrees. */
const DEFAULT_LOCK_SECONDS = 300;
/** Slack added past a job's timeout when extending its lock, so the timeout
 *  always fires before the (extended) lock expires. */
const TIMEOUT_LOCK_GRACE_MS = 5000;

export interface WorkerOptions {
  /** Polling interval when idle. Default 1000 ms. */
  intervalMs?: number;
  /** Max concurrent in-flight jobs. Default 1 (single-thread). */
  concurrency?: number;
  /** Hook for log lines — defaults to console.log/console.error. */
  logger?: (level: "info" | "warn" | "error", msg: string) => void;
  /** Seconds the running claim is valid for. Default 300. */
  lockSeconds?: number;
  /** Run handleStalled() at most this often (ms). Default 30 000. */
  stallSweepIntervalMs?: number;
  /**
   * Default hard wall-clock cap (ms) for a job's handler when the job row does
   * not set its own `timeoutMs`. A job exceeding it is dead-lettered and the
   * worker freed. 0 / undefined = no default cap (today's behavior). A per-job
   * `timeoutMs` always wins over this default.
   */
  jobTimeoutMs?: number;
  /**
   * Engine for the single-active-worker lock. When provided, the worker
   * elects one active instance via the `worker_lock` row (migration 042) and
   * heartbeats it each tick; other instances idle until the holder's heartbeat
   * lapses. Omit (e.g. in unit tests) to disable the guard entirely.
   */
  engine?: Engine;
  /** Lock id for the single-worker guard. Default `memex-jobs-worker`. */
  workerLockId?: string;
  /** Seconds before a missed heartbeat lets another worker steal. Default 60. */
  workerLockTtlSeconds?: number;
  /**
   * Only claim jobs of these kinds. Lets an auxiliary worker (e.g. the jobs
   * smoke self-test) coexist with the live worker without draining its queue.
   */
  kinds?: string[];
}

export interface WorkerStats {
  picked: number;
  succeeded: number;
  failed: number;
  retried: number;
  /** Total rows requeued by the stall sweep. */
  stallsRequeued: number;
  /** Total rows terminal-failed by the stall sweep. */
  stallsTerminallyFailed: number;
  /** Jobs dead-lettered by the per-job wall-clock timeout. */
  timedOut: number;
}

export class Worker {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inflight = 0;
  private stopping = false;
  private stopped = true;
  private lastStallSweep = 0;
  private holdsLock = false;
  private lockWarned = false;
  // Unique per Worker INSTANCE (not just per process): two Worker objects in
  // one process must be distinct holders, else both would re-acquire the same
  // lock (own-holder re-acquire always succeeds) and the guard would be moot.
  private readonly lockHolder = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  private readonly stats: WorkerStats = {
    picked: 0,
    succeeded: 0,
    failed: 0,
    retried: 0,
    stallsRequeued: 0,
    stallsTerminallyFailed: 0,
    timedOut: 0,
  };

  constructor(
    private readonly queue: Queue,
    private readonly opts: WorkerOptions = {},
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.stopping = false;
    this.scheduleNext(0);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    while (this.inflight > 0) {
      await sleep(25);
    }
    // Release the single-worker lock so a replacement can take over at once
    // (rather than waiting for the TTL to lapse).
    if (this.holdsLock && this.opts.engine) {
      try {
        await releaseWorkerLock(
          this.opts.engine,
          this.opts.workerLockId ?? DEFAULT_WORKER_LOCK_ID,
          this.lockHolder,
        );
      } catch (e) {
        this.log("error", `worker lock release failed: ${asMessage(e)}`);
      }
      this.holdsLock = false;
    }
    this.stopped = true;
  }

  /** Returns the running tally — useful for tests + the inspect CLI. */
  getStats(): Readonly<WorkerStats> {
    return { ...this.stats };
  }

  /**
   * Drain the queue once: claim and run jobs until `claim()` returns
   * null. Runs serially regardless of `concurrency`, so it's safe to
   * use from tests for deterministic ordering.
   */
  async drainOnce(): Promise<number> {
    let processed = 0;
    while (!this.stopping) {
      const job = await this.queue.claim(this.claimOpts());
      if (!job) break;
      await this.runJob(job);
      processed++;
    }
    return processed;
  }

  private claimOpts(): Parameters<Queue["claim"]>[0] {
    const claimOpts: Parameters<Queue["claim"]>[0] = {};
    if (this.opts.lockSeconds !== undefined) {
      claimOpts.lockSeconds = this.opts.lockSeconds;
    }
    if (this.opts.kinds !== undefined) {
      claimOpts.kinds = this.opts.kinds;
    }
    return claimOpts;
  }

  /** Run one stall sweep. Public so tests can advance it deterministically. */
  async sweepStalls(now: Date = new Date()): Promise<void> {
    const r = await this.queue.handleStalled({ now });
    this.stats.stallsRequeued += r.requeued;
    this.stats.stallsTerminallyFailed += r.terminallyFailed;
    this.lastStallSweep = now.getTime();
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopping) return;
    const interval = this.opts.intervalMs ?? 1000;
    this.timer = setTimeout(
      () => void this.tick(),
      Math.max(0, delayMs ?? interval),
    );
  }

  /**
   * Single-active-worker gate. Returns true when this worker may do work this
   * tick. No engine configured → always true (guard disabled). Otherwise
   * acquire-or-heartbeat the lock; a worker that can't acquire (another live
   * holder) or that lost its lock idles this tick and retries next.
   */
  private async ensureWorkerLock(): Promise<boolean> {
    const engine = this.opts.engine;
    if (!engine) return true;
    const id = this.opts.workerLockId ?? DEFAULT_WORKER_LOCK_ID;
    const ttl = this.opts.workerLockTtlSeconds ?? 60;
    if (this.holdsLock) {
      const kept = await heartbeatWorkerLock(engine, id, this.lockHolder);
      if (!kept) {
        this.holdsLock = false;
        this.log("warn", "lost worker lock (heartbeat stolen) — idling");
        return false;
      }
      return true;
    }
    this.holdsLock = await acquireWorkerLock(engine, id, this.lockHolder, ttl);
    if (this.holdsLock) {
      this.log("info", `acquired worker lock as ${this.lockHolder}`);
      this.lockWarned = false;
    } else if (!this.lockWarned) {
      this.log("info", "another worker holds the lock — idling");
      this.lockWarned = true;
    }
    return this.holdsLock;
  }

  private async tick(): Promise<void> {
    if (this.stopping) return;
    const concurrency = Math.max(1, this.opts.concurrency ?? 1);
    try {
      // Single-active-worker gate: idle this tick if another worker holds the
      // lock. The `finally` still reschedules, so we retry next interval.
      if (!(await this.ensureWorkerLock())) return;
      // Stall sweep first — recovers rows whose worker died last tick
      // before they get blocked behind fresh claims.
      const sweepInterval = this.opts.stallSweepIntervalMs ?? 30_000;
      const nowMs = Date.now();
      if (nowMs - this.lastStallSweep >= sweepInterval) {
        try {
          await this.sweepStalls(new Date(nowMs));
        } catch (e) {
          this.log("error", `stall sweep crashed: ${asMessage(e)}`);
        }
      }
      while (this.inflight < concurrency) {
        const job = await this.queue.claim(this.claimOpts());
        if (!job) break;
        this.inflight++;
        // Fire-and-forget; runJob updates inflight on completion. runJob never
        // throws (it guards its own bookkeeping), but keep a catch as a final
        // backstop so a stray rejection can never become an unhandledRejection.
        void this.runJob(job)
          .catch((e) => this.log("error", `[${job.id}] runJob: ${asMessage(e)}`))
          .finally(() => {
            this.inflight--;
          })
          // Terminal backstop: even the catch's logger or finally must never
          // surface as an unhandledRejection.
          .catch(() => {});
      }
    } catch (e) {
      this.log("error", `claim loop crashed: ${asMessage(e)}`);
    } finally {
      // If we picked something, retry quickly (more might be due);
      // otherwise wait the full interval.
      const idle = this.inflight === 0;
      this.scheduleNext(idle ? (this.opts.intervalMs ?? 1000) : 50);
    }
  }

  private async runJob(job: JobRow): Promise<void> {
    this.stats.picked++;
    const handler = getHandler(job.kind);
    if (!handler) {
      const msg = `no handler registered for kind '${job.kind}'`;
      this.log("error", `[${job.id}] ${msg}`);
      try {
        const updated = await this.queue.fail(job.id, msg);
        if (updated && updated.status === "pending") this.stats.retried++;
        else this.stats.failed++;
      } catch (e) {
        this.log("error", `[${job.id}] no-handler fail persist: ${asMessage(e)}`);
      }
      return;
    }
    // Per-job hard wall-clock cap (job row wins over the worker default).
    const timeoutMs = job.timeoutMs ?? this.opts.jobTimeoutMs ?? 0;
    // If the timeout outlasts the claim lock, extend the lock so the stall
    // sweep can't requeue the row before the timeout dead-letters it (the
    // terminal fail would then no-op on a row that is no longer 'running').
    if (timeoutMs > 0) {
      const lockMs = (this.opts.lockSeconds ?? DEFAULT_LOCK_SECONDS) * 1000;
      if (timeoutMs + TIMEOUT_LOCK_GRACE_MS > lockMs) {
        // The lock MUST cover the timeout, else the stall sweep could requeue
        // the row before the timeout dead-letters it. If we can't extend it
        // (DB error, or the claim was already lost), abort this attempt rather
        // than run a handler whose timeout can't be enforced — the job stays
        // claimable and a later tick retries it.
        let extended = false;
        try {
          extended = await this.queue.extendLock(
            job.id,
            new Date(Date.now() + timeoutMs + TIMEOUT_LOCK_GRACE_MS),
          );
        } catch (e) {
          this.log("error", `[${job.id}] extendLock failed: ${asMessage(e)}`);
        }
        if (!extended) {
          this.log(
            "warn",
            `[${job.id}] could not extend lock to cover timeout; skipping this attempt`,
          );
          return;
        }
      }
    }
    // Handler context: progress + token/cost usage persist onto the job row
    // while it runs (running-gated, so a lost claim makes them no-ops).
    const ctx = {
      job,
      updateProgress: (progress: Record<string, unknown>) =>
        this.queue.updateProgress(job.id, progress),
      recordUsage: (usage: Parameters<Queue["recordUsage"]>[1]) =>
        this.queue.recordUsage(job.id, usage),
    };
    // The whole body is guarded: a persistence failure (complete/fail) must
    // never crash the worker tick or escape as an unhandledRejection.
    try {
      try {
        const result =
          timeoutMs > 0
            ? await runWithTimeout(() => handler(job.payload, ctx), timeoutMs)
            : await handler(job.payload, ctx);
        await this.queue.complete(
          job.id,
          result === undefined ? {} : (result as Record<string, unknown>),
        );
        this.stats.succeeded++;
      } catch (e) {
        const message = asMessage(e);
        // A hard timeout dead-letters (terminal): JS cannot cancel the orphaned
        // handler, but the worker is freed and retrying would only wedge it again.
        const timedOut = e instanceof JobTimeoutError;
        this.log(
          "warn",
          `[${job.id}] ${job.kind} ${timedOut ? "timed out" : "failed"}: ${message}`,
        );
        const updated = await this.queue.fail(
          job.id,
          message,
          timedOut ? { terminal: true } : {},
        );
        if (timedOut) this.stats.timedOut++;
        if (updated && updated.status === "pending") {
          this.stats.retried++;
        } else {
          this.stats.failed++;
        }
      }
    } catch (e) {
      this.log("error", `[${job.id}] job bookkeeping failed: ${asMessage(e)}`);
    }
  }

  private log(level: "info" | "warn" | "error", msg: string): void {
    const fn = this.opts.logger;
    if (fn) {
      fn(level, msg);
      return;
    }
    if (level === "error" || level === "warn") {
      console.error(`[jobs] ${msg}`);
    } else {
      console.log(`[jobs] ${msg}`);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function asMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Thrown when a job handler exceeds its hard wall-clock cap. */
export class JobTimeoutError extends Error {
  constructor(ms: number) {
    super(`job exceeded its ${ms}ms timeout`);
    this.name = "JobTimeoutError";
  }
}

/**
 * Run `start()`'s promise under a hard wall-clock cap. On timeout the returned
 * promise rejects with `JobTimeoutError` and the worker moves on; the orphaned
 * handler keeps running (JS has no cancellation) but its late settlement is
 * swallowed so it never surfaces as an unhandledRejection. The timer is cleared
 * on the normal path so it can't keep the event loop alive.
 *
 * NOTE the orphan can still mutate NON-queue state (documents, chunks, ...)
 * after the dead-letter — the queue row is protected by `status='running'`
 * write guards, but a handler with external side effects must be idempotent.
 */
function runWithTimeout<T>(start: () => Promise<T>, ms: number): Promise<T> {
  let work: Promise<T>;
  try {
    work = start();
  } catch (e) {
    // A handler that throws synchronously (before returning a promise) becomes
    // a normal rejection so runJob's catch routes it through fail(). A thrown
    // non-Error is wrapped; `asMessage` already rendered it with String(), so
    // the dead-letter message is unchanged, and a real Error (JobTimeoutError
    // included) passes through untouched so the `instanceof` check still holds.
    return Promise.reject(e instanceof Error ? e : new Error(String(e)));
  }
  // Guard: if `work` loses the race and later rejects, swallow it here.
  work.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new JobTimeoutError(ms)), ms);
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
