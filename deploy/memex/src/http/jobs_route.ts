/**
 * Jobs DAG HTTP surface (Phase A.4). Same auth model as pages/graph/
 * entities: writes internal-only via MEMEX_INTERNAL_TOKEN, reads
 * open under the public-bearer gate.
 *
 * Public-read redaction: `payload`, `result`, and `last_error` may
 * carry sensitive content (URLs being fetched, OAuth response
 * excerpts, file paths inside handler errors, Bedrock model IDs).
 * Public-ingress responses strip them by default; full content is
 * available to internal callers (and via MCP for openclaw / Claude
 * Desktop). No `MEMEX_PUBLIC_READ_BODIES` opt-in here -- jobs
 * payload semantics are different from page bodies; if a future
 * use case needs raw payload to a public reader, add a dedicated
 * opt-in flag rather than reusing the page flag.
 */
import type { Storage } from "../core/storage.ts";
import { parseJsonBody } from "./body_limit.ts";
import {
  cancelJob,
  getJob,
  listJobs,
  submitJob,
  type JobDetail,
  type JobSummary,
  type ListJobsOptions,
  type SubmitJobInput,
} from "../core/jobs/dag.ts";

function errResponse(isPublic: boolean, e: unknown, status: number): Response {
  const msg = isPublic
    ? "jobs backend error"
    : e instanceof Error
      ? e.message
      : String(e);
  return Response.json({ ok: false, error: msg }, { status });
}

// Public-safe view of a single job. Drops payload / result entirely
// and replaces last_error with a generic marker so a public-bearer
// holder can monitor status without harvesting handler internals.
function publicJobDetail(job: JobDetail): Record<string, unknown> {
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    priority: job.priority,
    retry_count: job.retry_count,
    parent_job_id: job.parent_job_id,
    depth: job.depth,
    has_error: job.last_error !== null,
    has_result: job.result !== null,
    next_attempt_at: job.next_attempt_at,
    started_at: job.started_at,
    finished_at: job.finished_at,
    created_at: job.created_at,
    updated_at: job.updated_at,
    children: job.children.map((c) => ({
      child_id: c.child_id,
      kind: c.kind,
      status: c.status,
      created_at: c.created_at,
    })),
    inbox_unread: job.inbox_unread,
  };
}

function publicJobSummary(j: JobSummary): JobSummary {
  // JobSummary already omits payload/result/last_error in the SELECT;
  // identity here is intentional so callers can keep one branch.
  return j;
}

// ---------------------------------------------------------------------------
// WRITES
// ---------------------------------------------------------------------------

function isSubmitInput(b: unknown): b is SubmitJobInput {
  if (typeof b !== "object" || b === null) return false;
  const o = b as Record<string, unknown>;
  return (
    typeof o["kind"] === "string" &&
    (o["payload"] === undefined ||
      (typeof o["payload"] === "object" && o["payload"] !== null)) &&
    (o["priority"] === undefined || typeof o["priority"] === "number") &&
    (o["max_retries"] === undefined || typeof o["max_retries"] === "number") &&
    (o["parent_job_id"] === undefined ||
      typeof o["parent_job_id"] === "string") &&
    (o["idempotency_key"] === undefined ||
      typeof o["idempotency_key"] === "string") &&
    (o["not_before"] === undefined || typeof o["not_before"] === "string")
  );
}

export async function handleJobsSubmit(
  storage: Storage,
  req: Request,
  isPublic = false,
): Promise<Response> {
  const parsed = await parseJsonBody<SubmitJobInput>(req);
  if (!parsed.ok) return parsed.response;
  if (!isSubmitInput(parsed.body)) {
    return Response.json(
      { ok: false, error: "body must be { kind, ... }" },
      { status: 400 },
    );
  }
  try {
    const r = await submitJob(storage.engine(), parsed.body);
    return Response.json({ ok: true, ...r });
  } catch (e) {
    return errResponse(isPublic, e, 400);
  }
}

interface CancelRequest {
  id: string;
  cascade?: boolean;
  reason?: string;
}
function isCancelRequest(b: unknown): b is CancelRequest {
  if (typeof b !== "object" || b === null) return false;
  const o = b as Record<string, unknown>;
  return (
    typeof o["id"] === "string" &&
    (o["cascade"] === undefined || typeof o["cascade"] === "boolean") &&
    (o["reason"] === undefined || typeof o["reason"] === "string")
  );
}

export async function handleJobsCancel(
  storage: Storage,
  req: Request,
  isPublic = false,
): Promise<Response> {
  const parsed = await parseJsonBody<CancelRequest>(req);
  if (!parsed.ok) return parsed.response;
  if (!isCancelRequest(parsed.body)) {
    return Response.json(
      { ok: false, error: "body must be { id, cascade?, reason? }" },
      { status: 400 },
    );
  }
  try {
    const opts: { cascade?: boolean; reason?: string } = {};
    if (parsed.body.cascade !== undefined) opts.cascade = parsed.body.cascade;
    if (parsed.body.reason !== undefined) {
      // Cap reason at 512 chars: it's persisted as last_error and
      // re-served to every public read of the job. A 1MB reason from
      // a buggy caller would blow up every status check.
      opts.reason = parsed.body.reason.slice(0, 512);
    }
    const r = await cancelJob(storage.engine(), parsed.body.id, opts);
    return Response.json({ ok: true, ...r });
  } catch (e) {
    return errResponse(isPublic, e, 400);
  }
}

// ---------------------------------------------------------------------------
// READS
// ---------------------------------------------------------------------------

function isListRequest(b: unknown): b is ListJobsOptions {
  if (typeof b !== "object" || b === null) return false;
  const o = b as Record<string, unknown>;
  return (
    (o["status"] === undefined || typeof o["status"] === "string") &&
    (o["kind"] === undefined || typeof o["kind"] === "string") &&
    (o["parent_job_id"] === undefined ||
      typeof o["parent_job_id"] === "string") &&
    (o["since"] === undefined || typeof o["since"] === "string") &&
    (o["limit"] === undefined || typeof o["limit"] === "number")
  );
}

export async function handleJobsList(
  storage: Storage,
  req: Request,
  isPublic = false,
): Promise<Response> {
  const parsed = await parseJsonBody<ListJobsOptions>(req);
  if (!parsed.ok) return parsed.response;
  // 400 on malformed body so a bad caller cannot silently enumerate
  // everything with an empty default filter.
  if (!isListRequest(parsed.body)) {
    return Response.json(
      {
        ok: false,
        error:
          "body must be { status?, kind?, parent_job_id?, since?, limit? }",
      },
      { status: 400 },
    );
  }
  try {
    const jobs = await listJobs(storage.engine(), parsed.body);
    const out = isPublic ? jobs.map(publicJobSummary) : jobs;
    return Response.json({ ok: true, jobs: out });
  } catch (e) {
    return errResponse(isPublic, e, 500);
  }
}

interface GetRequest {
  id: string;
}
function isGetRequest(b: unknown): b is GetRequest {
  if (typeof b !== "object" || b === null) return false;
  const o = b as Record<string, unknown>;
  return typeof o["id"] === "string";
}

export async function handleJobsGet(
  storage: Storage,
  req: Request,
  isPublic = false,
): Promise<Response> {
  const parsed = await parseJsonBody<GetRequest>(req);
  if (!parsed.ok) return parsed.response;
  if (!isGetRequest(parsed.body)) {
    return Response.json(
      { ok: false, error: "body must be { id }" },
      { status: 400 },
    );
  }
  try {
    const job = await getJob(storage.engine(), parsed.body.id);
    if (!job) {
      return Response.json({ ok: false, error: "not found" }, { status: 404 });
    }
    const out = isPublic ? publicJobDetail(job) : job;
    return Response.json({ ok: true, job: out });
  } catch (e) {
    return errResponse(isPublic, e, 400);
  }
}

/**
 * Compact log shape for the agent: the job + its children + unread
 * inbox count, designed to fit in a single Telegram reply when the
 * operator asks "what's the status of job X?".
 */
export async function handleJobsLogs(
  storage: Storage,
  req: Request,
  isPublic = false,
): Promise<Response> {
  const parsed = await parseJsonBody<GetRequest>(req);
  if (!parsed.ok) return parsed.response;
  if (!isGetRequest(parsed.body)) {
    return Response.json(
      { ok: false, error: "body must be { id }" },
      { status: 400 },
    );
  }
  try {
    const job = await getJob(storage.engine(), parsed.body.id);
    if (!job) {
      return Response.json({ ok: false, error: "not found" }, { status: 404 });
    }
    const log: Record<string, unknown> = {
      id: job.id,
      kind: job.kind,
      status: job.status,
      retry_count: job.retry_count,
      created_at: job.created_at,
      updated_at: job.updated_at,
      started_at: job.started_at,
      finished_at: job.finished_at,
      depth: job.depth,
      parent_job_id: job.parent_job_id,
      children_count: job.children.length,
      children_by_status: job.children.reduce<Record<string, number>>(
        (acc, c) => {
          acc[c.status] = (acc[c.status] ?? 0) + 1;
          return acc;
        },
        {},
      ),
      inbox_unread: job.inbox_unread,
    };
    // last_error often contains raw exception text from worker
    // handlers -- SQL paths, file paths, model IDs. Public ingress
    // gets only a `has_error` boolean.
    if (isPublic) {
      log.has_error = job.last_error !== null;
    } else {
      log.last_error = job.last_error;
    }
    return Response.json({ ok: true, log });
  } catch (e) {
    return errResponse(isPublic, e, 400);
  }
}
