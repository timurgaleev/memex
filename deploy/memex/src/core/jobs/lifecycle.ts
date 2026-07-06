/**
 * Job lifecycle surface — the core APIs behind `memex jobs submit / delete /
 * prune / smoke` and the MCP `retry_job` / `get_job_progress` operations.
 * CLI and MCP layers call these; nothing here prints or parses flags.
 *
 * The heavy lifting (SQL) lives on Queue; this module adds the submit-side
 * validation, the progress read shape, and the self-contained smoke test.
 */
import { randomUUID } from "node:crypto";
import type { Engine } from "../engine/interface.ts";
import { isValidKind, registerHandler, getHandler } from "./handlers.ts";
import { Queue } from "./queue.ts";
import { Worker } from "./worker.ts";
import type { EnqueueInput, JobRow, JobStatus } from "./types.ts";

/**
 * Validated submit for operator-supplied input (CLI / MCP). Beyond
 * `Queue.enqueue`'s own numeric guards this rejects a malformed kind up
 * front — a typo'd kind would otherwise sit pending forever and then
 * dead-letter with "no handler registered".
 */
export async function submitJob(
  queue: Queue,
  input: EnqueueInput,
): Promise<JobRow> {
  if (!input.kind || !isValidKind(input.kind)) {
    throw new Error(
      `submitJob: invalid kind '${input.kind}' (lowercase, [a-z0-9._-])`,
    );
  }
  return queue.enqueue(input);
}

/** The MCP `get_job_progress` shape: status + handler-reported progress. */
export interface JobProgress {
  id: string;
  kind: string;
  status: JobStatus;
  progress: Record<string, unknown> | null;
}

/** Read a job's progress envelope. Null when the job does not exist. */
export async function getJobProgress(
  queue: Queue,
  id: string,
): Promise<JobProgress | null> {
  const job = await queue.get(id);
  if (!job) return null;
  return { id: job.id, kind: job.kind, status: job.status, progress: job.progress };
}

const SMOKE_KIND = "jobs.smoke-noop";

export interface JobsSmokeResult {
  ok: boolean;
  jobId: string;
  status: JobStatus | "timeout";
  elapsedMs: number;
  error?: string;
}

export interface JobsSmokeOptions {
  /** Wall-clock budget for the round trip. Default 15 000 ms. */
  timeoutMs?: number;
}

/**
 * End-to-end queue self-test: enqueue a noop job and run it through the real
 * claim → dispatch → complete path, then delete the row. The throwaway worker
 * is kind-restricted to the smoke kind and skips the single-active-worker
 * lock, so it cannot drain or fight a live worker's queue. Any live worker
 * that picks the smoke job first also completes it — either outcome passes.
 */
export async function runJobsSmoke(
  engine: Engine,
  opts: JobsSmokeOptions = {},
): Promise<JobsSmokeResult> {
  const start = Date.now();
  const timeoutMs = opts.timeoutMs ?? 15_000;
  if (!getHandler(SMOKE_KIND)) {
    registerHandler(SMOKE_KIND, async () => ({
      ok: true,
      at: new Date().toISOString(),
    }));
  }
  const queue = new Queue(engine);
  const job = await queue.enqueue({
    kind: SMOKE_KIND,
    id: `smoke-${randomUUID()}`,
    priority: 1,
    maxRetries: 0,
  });
  const worker = new Worker(queue, { kinds: [SMOKE_KIND] });
  let final: JobRow | null = null;
  try {
    while (Date.now() - start < timeoutMs) {
      await worker.drainOnce();
      final = await queue.get(job.id);
      if (final && final.status !== "pending" && final.status !== "running") {
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  } finally {
    await worker.stop();
  }
  const elapsedMs = Date.now() - start;
  if (!final || final.status === "pending" || final.status === "running") {
    return { ok: false, jobId: job.id, status: "timeout", elapsedMs };
  }
  await queue.remove(job.id);
  const result: JobsSmokeResult = {
    ok: final.status === "succeeded",
    jobId: job.id,
    status: final.status,
    elapsedMs,
  };
  if (final.lastError) result.error = final.lastError;
  return result;
}
