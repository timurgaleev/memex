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
  type FrictionKind,
} from "../core/friction.ts";

const VALID_KINDS: ReadonlySet<FrictionKind> = new Set([
  "search-miss",
  "wrong-answer",
  "tool-error",
  "low-confidence",
  "other",
]);

export async function handleFrictionPost(
  storage: Storage,
  req: Request,
): Promise<Response> {
  let body: {
    kind?: FrictionKind;
    query?: string;
    reason?: string;
    sourcePath?: string;
    extra?: Record<string, unknown>;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json(
      { ok: false, error: "invalid JSON body" },
      { status: 400 },
    );
  }
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
