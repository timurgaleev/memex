/**
 * Body-size gate for every HTTP POST handler.
 *
 * Threat: `await req.json()` reads the entire request body into memory
 * before parsing. Bun has no built-in cap; a public bearer holder (or
 * any internal caller) could POST a multi-GB body and OOM the daemon
 * on a t4g.medium instance.
 *
 * Defence: before `await req.json()`, inspect `Content-Length`. If it
 * exceeds `MAX_HTTP_BODY_BYTES` (1 MiB by default), respond 413
 * synchronously without reading the stream. Callers wrap their parse
 * with `parseJsonBody(req)` which returns either the parsed body or a
 * pre-built Response to short-circuit.
 */
const DEFAULT_MAX_BODY_BYTES = 1 * 1024 * 1024; // 1 MiB

function getCap(): number {
  const raw = process.env.MEMEX_MAX_BODY_BYTES;
  if (!raw) return DEFAULT_MAX_BODY_BYTES;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_BODY_BYTES;
  return n;
}

export type ParseResult<T> =
  | { ok: true; body: T }
  | { ok: false; response: Response };

/**
 * Read and JSON-parse a request body with a hard size cap. The cap
 * default is 1 MiB; override via `MEMEX_MAX_BODY_BYTES` env when the
 * route genuinely needs more (none today).
 *
 * Returns the parsed body on success, or a ready-to-return Response
 * (status 400 or 413) on failure. Callers MUST check `ok` before
 * touching `body`.
 */
export async function parseJsonBody<T>(req: Request): Promise<ParseResult<T>> {
  const cap = getCap();
  const cl = req.headers.get("content-length");
  if (cl !== null) {
    const declared = Number.parseInt(cl, 10);
    if (Number.isFinite(declared) && declared > cap) {
      return {
        ok: false,
        response: Response.json(
          { ok: false, error: `request body exceeds ${cap} byte cap` },
          { status: 413 },
        ),
      };
    }
  }
  // Fall back to consuming the stream when Content-Length is absent
  // (rare for fetch / curl, but a malicious client can omit the
  // header). Read into a buffer and bail if it overflows the cap
  // before parsing JSON.
  let text: string;
  try {
    const buf = await req.arrayBuffer();
    if (buf.byteLength > cap) {
      return {
        ok: false,
        response: Response.json(
          { ok: false, error: `request body exceeds ${cap} byte cap` },
          { status: 413 },
        ),
      };
    }
    text = new TextDecoder().decode(buf);
  } catch {
    // A stream-read failure carries no info a client needs — return a
    // constant so the raw error (which could surface internals) never
    // crosses the boundary, even if a future caller forwards `response`.
    return {
      ok: false,
      response: Response.json(
        { ok: false, error: "body read failed" },
        { status: 400 },
      ),
    };
  }
  try {
    return { ok: true, body: JSON.parse(text) as T };
  } catch {
    return {
      ok: false,
      response: Response.json(
        { ok: false, error: "request body must be valid JSON" },
        { status: 400 },
      ),
    };
  }
}
