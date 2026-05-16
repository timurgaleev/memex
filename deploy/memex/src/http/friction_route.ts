/**
 * POST /friction — log a friction event from a chat / agent / cron.
 *
 * Body: { kind, query?, reason?, sourcePath?, extra? }
 * Response: { ok: true } on accept, error envelope on validation fail.
 *
 * GET /friction (no body) — returns analyzeFriction() summary.
 */
import type { Storage } from "../core/storage.ts";
import {
  analyzeFriction,
  logFriction,
  VALID_FRICTION_KINDS,
  type FrictionKind,
} from "../core/friction.ts";
import { parseJsonBody } from "./body_limit.ts";

const VALID_KINDS = VALID_FRICTION_KINDS;

export async function handleFrictionPost(
  storage: Storage,
  req: Request,
): Promise<Response> {
  type FrictionPostBody = {
    kind?: FrictionKind;
    query?: string;
    reason?: string;
    sourcePath?: string;
    extra?: Record<string, unknown>;
  };
  const parsed = await parseJsonBody<FrictionPostBody>(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  if (!body.kind || !VALID_KINDS.has(body.kind)) {
    return Response.json(
      {
        ok: false,
        error: `kind must be one of ${[...VALID_KINDS].join("|")}`,
      },
      { status: 400 },
    );
  }
  try {
    const input: Parameters<typeof logFriction>[1] = { kind: body.kind };
    if (body.query !== undefined) input.query = body.query;
    if (body.reason !== undefined) input.reason = body.reason;
    if (body.sourcePath !== undefined) input.sourcePath = body.sourcePath;
    if (body.extra !== undefined) input.extra = body.extra;
    await logFriction(storage.engine(), input);
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

export async function handleFrictionGet(storage: Storage): Promise<Response> {
  try {
    const r = await analyzeFriction(storage.engine(), { sinceHours: 168 });
    return Response.json({ ok: true, ...r });
  } catch (e) {
    return Response.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
