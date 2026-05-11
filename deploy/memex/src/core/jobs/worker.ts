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
import { getHandler } from "./handlers.ts";
import type { Queue } from "./queue.ts";
import type { JobRow } from "./types.ts";

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
}

export class Worker {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inflight = 0;
  private stopping = false;
  private stopped = true;
  private lastStallSweep = 0;
  private readonly stats: WorkerStats = {
    picked: 0,
    succeeded: 0,
    failed: 0,
    retried: 0,
    stallsRequeued: 0,
    stallsTerminallyFailed: 0,
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
      const claimOpts: Parameters<typeof this.queue.claim>[0] = {};
      if (this.opts.lockSeconds !== undefined) {
        claimOpts.lockSeconds = this.opts.lockSeconds;
      }
      const job = await this.queue.claim(claimOpts);
      if (!job) break;
      await this.runJob(job);
      processed++;
    }
    return processed;
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

  private async tick(): Promise<void> {
    if (this.stopping) return;
    const concurrency = Math.max(1, this.opts.concurrency ?? 1);
    try {
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
        const claimOpts: Parameters<typeof this.queue.claim>[0] = {};
        if (this.opts.lockSeconds !== undefined) {
          claimOpts.lockSeconds = this.opts.lockSeconds;
        }
        const job = await this.queue.claim(claimOpts);
        if (!job) break;
        this.inflight++;
        // Fire-and-forget; runJob updates inflight on completion.
        void this.runJob(job).finally(() => {
          this.inflight--;
        });
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
      const updated = await this.queue.fail(job.id, msg);
      if (updated && updated.status === "pending") this.stats.retried++;
      else this.stats.failed++;
      return;
    }
    try {
      const result = await handler(job.payload, { job });
      await this.queue.complete(
        job.id,
        result === undefined ? {} : (result as Record<string, unknown>),
      );
      this.stats.succeeded++;
    } catch (e) {
      const message = asMessage(e);
      this.log("warn", `[${job.id}] ${job.kind} failed: ${message}`);
      const updated = await this.queue.fail(job.id, message);
      if (updated && updated.status === "pending") {
        this.stats.retried++;
      } else {
        this.stats.failed++;
      }
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
