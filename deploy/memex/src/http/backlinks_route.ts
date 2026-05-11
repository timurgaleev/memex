/**
 * POST /backlinks — JSON-RPC-ish: { name, type?, limit? } → { ok, hits }
 */
import type { Storage } from "../core/storage.ts";
import { findBacklinks } from "../core/backlinks.ts";
import type { EntityType } from "../core/entities.ts";

interface BacklinksRequest {
  name?: string;
  type?: EntityType;
  limit?: number;
}

const VALID_TYPES: ReadonlySet<EntityType> = new Set([
  "wikilink",
  "tag",
  "date",
]);

export async function handleBacklinks(
  storage: Storage,
  req: Request,
): Promise<Response> {
  let body: BacklinksRequest;
  try {
    body = (await req.json()) as BacklinksRequest;
  } catch {
    return Response.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }
  if (!body.name || typeof body.name !== "string") {
    return Response.json(
      { ok: false, error: "`name` is required and must be a string" },
      { status: 400 },
    );
  }
  if (body.type !== undefined && !VALID_TYPES.has(body.type)) {
    return Response.json(
      { ok: false, error: `invalid type: ${body.type}` },
      { status: 400 },
    );
  }
  if (body.limit !== undefined) {
    if (
      !Number.isInteger(body.limit) ||
      body.limit < 1 ||
      body.limit > 1000
    ) {
      return Response.json(
        { ok: false, error: "limit must be an integer in [1, 1000]" },
        { status: 400 },
      );
    }
  }
  try {
    const opts: Parameters<typeof findBacklinks>[2] = {};
    if (body.type !== undefined) opts.type = body.type;
    if (body.limit !== undefined) opts.limit = body.limit;
    const hits = await findBacklinks(storage, body.name, opts);
    return Response.json({ ok: true, name: body.name, hits });
  } catch (e) {
    return Response.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
