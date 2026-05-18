/**
 * Entity-recall + facts HTTP surface (Phase A.3).
 *
 * Routes:
 *   POST /entities/facts/add       internal-only (MEMEX_INTERNAL_TOKEN)
 *   POST /timeline/add             internal-only (MEMEX_INTERNAL_TOKEN)
 *   POST /entities/facts           public + bearer (READ)
 *   POST /entities/timeline        public + bearer (READ)
 *   POST /entities/recall          public + bearer (READ; redacts body)
 *
 * Mirrors the pages/graph auth model: writes internal-only, reads
 * open under the existing public-bearer gate. The entity_recall
 * response carries `page.markdown_body` so we apply the same
 * redaction policy as `/pages/get` — body stripped on public ingress
 * unless `MEMEX_PUBLIC_READ_BODIES=1`.
 */
import type { Storage } from "../core/storage.ts";
import { parseJsonBody } from "./body_limit.ts";
import { PUBLIC_GUARD_INTERNALS } from "./public_guard.ts";
import {
  addTimelineEvent,
  getEntityTimeline,
  type AddTimelineEventInput,
  type ListTimelineOptions,
} from "../core/timeline.ts";
import {
  addFact,
  entityRecall,
  listFacts,
  type AddFactInput,
  type EntityRecallOptions,
  type ListFactsOptions,
} from "../core/facts.ts";

function errResponse(isPublic: boolean, e: unknown, status: number): Response {
  const msg = isPublic
    ? "entities backend error"
    : e instanceof Error
      ? e.message
      : String(e);
  return Response.json({ ok: false, error: msg }, { status });
}

function shouldRedactForPublic(isPublic: boolean): boolean {
  return isPublic && !PUBLIC_GUARD_INTERNALS.publicReadBodiesAllowed();
}

// ---------------------------------------------------------------------------
// WRITES — internal-only
// ---------------------------------------------------------------------------

function isAddFactInput(b: unknown): b is AddFactInput {
  if (typeof b !== "object" || b === null) return false;
  const o = b as Record<string, unknown>;
  return (
    typeof o["entity_slug"] === "string" &&
    typeof o["fact"] === "string" &&
    (o["confidence"] === undefined || typeof o["confidence"] === "number") &&
    (o["source_slug"] === undefined || typeof o["source_slug"] === "string") &&
    (o["source_chunk_id"] === undefined ||
      typeof o["source_chunk_id"] === "string") &&
    (o["written_by"] === undefined || typeof o["written_by"] === "string")
  );
}

export async function handleAddFact(
  storage: Storage,
  req: Request,
  isPublic = false,
): Promise<Response> {
  const parsed = await parseJsonBody<AddFactInput>(req);
  if (!parsed.ok) return parsed.response;
  if (!isAddFactInput(parsed.body)) {
    return Response.json(
      { ok: false, error: "body must be { entity_slug, fact, ... }" },
      { status: 400 },
    );
  }
  try {
    const r = await addFact(storage, parsed.body);
    return Response.json({ ok: true, ...r });
  } catch (e) {
    return errResponse(isPublic, e, 400);
  }
}

function isAddTimelineEventInput(b: unknown): b is AddTimelineEventInput {
  if (typeof b !== "object" || b === null) return false;
  const o = b as Record<string, unknown>;
  return (
    typeof o["slug"] === "string" &&
    (typeof o["occurred_at"] === "string" || o["occurred_at"] instanceof Date) &&
    typeof o["event"] === "string" &&
    (o["source_chunk_id"] === undefined ||
      typeof o["source_chunk_id"] === "string")
  );
}

export async function handleAddTimelineEvent(
  storage: Storage,
  req: Request,
  isPublic = false,
): Promise<Response> {
  const parsed = await parseJsonBody<AddTimelineEventInput>(req);
  if (!parsed.ok) return parsed.response;
  if (!isAddTimelineEventInput(parsed.body)) {
    return Response.json(
      { ok: false, error: "body must be { slug, occurred_at, event, ... }" },
      { status: 400 },
    );
  }
  try {
    const r = await addTimelineEvent(storage, parsed.body);
    return Response.json({ ok: true, ...r });
  } catch (e) {
    return errResponse(isPublic, e, 400);
  }
}

// ---------------------------------------------------------------------------
// READS — open under the public-bearer gate
// ---------------------------------------------------------------------------

interface EntityFactsRequest extends ListFactsOptions {
  entity_slug: string;
}
function isEntityFactsRequest(b: unknown): b is EntityFactsRequest {
  if (typeof b !== "object" || b === null) return false;
  const o = b as Record<string, unknown>;
  return (
    typeof o["entity_slug"] === "string" &&
    (o["since"] === undefined || typeof o["since"] === "string") &&
    (o["source_slug"] === undefined || typeof o["source_slug"] === "string") &&
    (o["order"] === undefined ||
      o["order"] === "confidence" ||
      o["order"] === "recency") &&
    (o["limit"] === undefined || typeof o["limit"] === "number")
  );
}

export async function handleEntityFacts(
  storage: Storage,
  req: Request,
  isPublic = false,
): Promise<Response> {
  const parsed = await parseJsonBody<EntityFactsRequest>(req);
  if (!parsed.ok) return parsed.response;
  if (!isEntityFactsRequest(parsed.body)) {
    return Response.json(
      { ok: false, error: "body must be { entity_slug, ... }" },
      { status: 400 },
    );
  }
  try {
    const { entity_slug, ...opts } = parsed.body;
    const facts = await listFacts(storage, entity_slug, opts);
    return Response.json({ ok: true, entity_slug, facts });
  } catch (e) {
    return errResponse(isPublic, e, 400);
  }
}

interface EntityTimelineRequest extends ListTimelineOptions {
  slug: string;
}
function isEntityTimelineRequest(b: unknown): b is EntityTimelineRequest {
  if (typeof b !== "object" || b === null) return false;
  const o = b as Record<string, unknown>;
  return (
    typeof o["slug"] === "string" &&
    (o["since"] === undefined || typeof o["since"] === "string") &&
    (o["until"] === undefined || typeof o["until"] === "string") &&
    (o["limit"] === undefined || typeof o["limit"] === "number")
  );
}

export async function handleEntityTimeline(
  storage: Storage,
  req: Request,
  isPublic = false,
): Promise<Response> {
  const parsed = await parseJsonBody<EntityTimelineRequest>(req);
  if (!parsed.ok) return parsed.response;
  if (!isEntityTimelineRequest(parsed.body)) {
    return Response.json(
      { ok: false, error: "body must be { slug, ... }" },
      { status: 400 },
    );
  }
  try {
    const { slug, ...opts } = parsed.body;
    const timeline = await getEntityTimeline(storage, slug, opts);
    return Response.json({ ok: true, slug, timeline });
  } catch (e) {
    return errResponse(isPublic, e, 400);
  }
}

interface EntityRecallRequest {
  slug: string;
  fact_limit?: number;
  timeline_limit?: number;
}
function isEntityRecallRequest(b: unknown): b is EntityRecallRequest {
  if (typeof b !== "object" || b === null) return false;
  const o = b as Record<string, unknown>;
  return (
    typeof o["slug"] === "string" &&
    (o["fact_limit"] === undefined || typeof o["fact_limit"] === "number") &&
    (o["timeline_limit"] === undefined ||
      typeof o["timeline_limit"] === "number")
  );
}

export async function handleEntityRecall(
  storage: Storage,
  req: Request,
  isPublic = false,
): Promise<Response> {
  const parsed = await parseJsonBody<EntityRecallRequest>(req);
  if (!parsed.ok) return parsed.response;
  if (!isEntityRecallRequest(parsed.body)) {
    return Response.json(
      { ok: false, error: "body must be { slug, ... }" },
      { status: 400 },
    );
  }
  try {
    const opts: EntityRecallOptions = { redact_body: shouldRedactForPublic(isPublic) };
    if (parsed.body.fact_limit !== undefined)
      opts.fact_limit = parsed.body.fact_limit;
    if (parsed.body.timeline_limit !== undefined)
      opts.timeline_limit = parsed.body.timeline_limit;
    const r = await entityRecall(storage, parsed.body.slug, opts);
    return Response.json({ ok: true, ...r });
  } catch (e) {
    return errResponse(isPublic, e, 400);
  }
}
