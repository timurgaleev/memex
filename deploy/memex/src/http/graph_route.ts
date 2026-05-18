/**
 * Graph HTTP surface — page-to-page typed relationships over migration
 * 016_links_typed. Mirrors the pages_route auth model:
 *   - WRITE  POST /graph/link, POST /graph/unlink — internal-only.
 *   - READ   POST /graph/neighbors, POST /graph/query — open under the
 *            public-bearer gate; redaction does not apply (the link
 *            payload has no body text, only slug/type metadata).
 */
import type { Storage } from "../core/storage.ts";
import { parseJsonBody } from "./body_limit.ts";
import {
  addLink,
  graphNeighbors,
  graphQuery,
  removeLink,
  type AddLinkInput,
  type GraphNeighborsOptions,
  type GraphQueryOptions,
  type RemoveLinkInput,
} from "../core/links.ts";

function errResponse(isPublic: boolean, e: unknown, status: number): Response {
  const msg = isPublic
    ? "graph backend error"
    : e instanceof Error
      ? e.message
      : String(e);
  return Response.json({ ok: false, error: msg }, { status });
}

// ---------------------------------------------------------------------------
// WRITES
// ---------------------------------------------------------------------------

function isAddLinkInput(b: unknown): b is AddLinkInput {
  if (typeof b !== "object" || b === null) return false;
  const o = b as Record<string, unknown>;
  return (
    typeof o["source_slug"] === "string" &&
    typeof o["target_slug"] === "string" &&
    typeof o["type"] === "string" &&
    (o["confidence"] === undefined || typeof o["confidence"] === "number") &&
    (o["source_chunk_id"] === undefined ||
      typeof o["source_chunk_id"] === "string") &&
    (o["allowAdHocType"] === undefined ||
      typeof o["allowAdHocType"] === "boolean")
  );
}

export async function handleGraphLink(
  storage: Storage,
  req: Request,
  isPublic = false,
): Promise<Response> {
  const parsed = await parseJsonBody<AddLinkInput>(req);
  if (!parsed.ok) return parsed.response;
  if (!isAddLinkInput(parsed.body)) {
    return Response.json(
      {
        ok: false,
        error: "body must be { source_slug, target_slug, type, ... }",
      },
      { status: 400 },
    );
  }
  try {
    const r = await addLink(storage, parsed.body);
    return Response.json({ ok: true, ...r });
  } catch (e) {
    return errResponse(isPublic, e, 400);
  }
}

function isRemoveLinkInput(b: unknown): b is RemoveLinkInput {
  if (typeof b !== "object" || b === null) return false;
  const o = b as Record<string, unknown>;
  return (
    typeof o["source_slug"] === "string" &&
    typeof o["target_slug"] === "string" &&
    typeof o["type"] === "string"
  );
}

export async function handleGraphUnlink(
  storage: Storage,
  req: Request,
  isPublic = false,
): Promise<Response> {
  const parsed = await parseJsonBody<RemoveLinkInput>(req);
  if (!parsed.ok) return parsed.response;
  if (!isRemoveLinkInput(parsed.body)) {
    return Response.json(
      {
        ok: false,
        error: "body must be { source_slug, target_slug, type }",
      },
      { status: 400 },
    );
  }
  try {
    const r = await removeLink(storage, parsed.body);
    return Response.json({ ok: true, ...r });
  } catch (e) {
    return errResponse(isPublic, e, 400);
  }
}

// ---------------------------------------------------------------------------
// READS
// ---------------------------------------------------------------------------

interface NeighborsRequest {
  slug: string;
  type?: string;
  direction?: "outbound" | "inbound" | "both";
  limit?: number;
}
function isNeighborsRequest(b: unknown): b is NeighborsRequest {
  if (typeof b !== "object" || b === null) return false;
  const o = b as Record<string, unknown>;
  return (
    typeof o["slug"] === "string" &&
    (o["type"] === undefined || typeof o["type"] === "string") &&
    (o["direction"] === undefined ||
      o["direction"] === "outbound" ||
      o["direction"] === "inbound" ||
      o["direction"] === "both") &&
    (o["limit"] === undefined || typeof o["limit"] === "number")
  );
}

export async function handleGraphNeighbors(
  storage: Storage,
  req: Request,
  isPublic = false,
): Promise<Response> {
  const parsed = await parseJsonBody<NeighborsRequest>(req);
  if (!parsed.ok) return parsed.response;
  if (!isNeighborsRequest(parsed.body)) {
    return Response.json(
      { ok: false, error: "body must be { slug, type?, direction?, limit? }" },
      { status: 400 },
    );
  }
  try {
    const opts: GraphNeighborsOptions = {};
    if (parsed.body.type !== undefined) opts.type = parsed.body.type;
    if (parsed.body.direction !== undefined) opts.direction = parsed.body.direction;
    if (parsed.body.limit !== undefined) opts.limit = parsed.body.limit;
    const links = await graphNeighbors(storage, parsed.body.slug, opts);
    return Response.json({ ok: true, slug: parsed.body.slug, links });
  } catch (e) {
    return errResponse(isPublic, e, 400);
  }
}

function isGraphQueryRequest(b: unknown): b is GraphQueryOptions {
  if (typeof b !== "object" || b === null) return false;
  const o = b as Record<string, unknown>;
  return (
    typeof o["type"] === "string" &&
    (o["source_slug"] === undefined || typeof o["source_slug"] === "string") &&
    (o["target_slug"] === undefined || typeof o["target_slug"] === "string") &&
    (o["limit"] === undefined || typeof o["limit"] === "number")
  );
}

export async function handleGraphQuery(
  storage: Storage,
  req: Request,
  isPublic = false,
): Promise<Response> {
  const parsed = await parseJsonBody<GraphQueryOptions>(req);
  if (!parsed.ok) return parsed.response;
  if (!isGraphQueryRequest(parsed.body)) {
    return Response.json(
      { ok: false, error: "body must be { type, source_slug?, target_slug?, limit? }" },
      { status: 400 },
    );
  }
  try {
    const links = await graphQuery(storage, parsed.body);
    return Response.json({ ok: true, links });
  } catch (e) {
    return errResponse(isPublic, e, 400);
  }
}
