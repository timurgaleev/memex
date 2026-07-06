/**
 * Body-size gate for every HTTP POST handler.
 *
 * Threat: `await req.json()` reads the entire request body into memory
 * before parsing. Bun has no built-in cap; a public bearer holder (or
 * any internal caller) could POST a multi-GB body and OOM the daemon
 * on a t4g.medium instance.
 *
 * Defence: before reading, inspect `Content-Length`. If it exceeds
 * `MAX_HTTP_BODY_BYTES` (1 MiB by default), respond 413 synchronously
 * without reading the stream. When the header is absent (chunked
 * transfer), the stream is counted chunk-by-chunk and CANCELLED the
 * moment the running total passes the cap — the oversized tail is never
 * buffered, which is the OOM this module exists to prevent. Callers
 * wrap their parse with `parseJsonBody(req)` which returns either the
 * parsed body or a pre-built Response to short-circuit.
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

export type ReadBodyResult =
  | { ok: true; buf: Uint8Array }
  | { ok: false; response: Response };

function overCapResponse(cap: number): Response {
  return Response.json(
    { ok: false, error: `request body exceeds ${cap} byte cap` },
    { status: 413 },
  );
}

/**
 * Read a request body into memory with a hard byte cap, counting the
 * stream as it arrives. A declared `Content-Length` over the cap is
 * rejected without touching the stream; an undeclared (chunked) body is
 * aborted mid-stream as soon as the count crosses the cap, so at most
 * `cap` + one chunk ever sits in memory. Shared by the JSON parse path
 * below and raw-body routes (POST /ingest).
 */
export async function readBodyWithCap(
  req: Request,
  cap: number = getCap(),
): Promise<ReadBodyResult> {
  const cl = req.headers.get("content-length");
  if (cl !== null) {
    const declared = Number.parseInt(cl, 10);
    if (Number.isFinite(declared) && declared > cap) {
      return { ok: false, response: overCapResponse(cap) };
    }
  }
  const stream = req.body;
  if (stream === null) return { ok: true, buf: new Uint8Array(0) };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > cap) {
        // Abort the transfer — do NOT buffer the rest of the stream.
        await reader.cancel().catch(() => {});
        return { ok: false, response: overCapResponse(cap) };
      }
      chunks.push(value);
    }
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
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    buf.set(c, offset);
    offset += c.byteLength;
  }
  return { ok: true, buf };
}

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
  const read = await readBodyWithCap(req);
  if (!read.ok) return read;
  const text = new TextDecoder().decode(read.buf);
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
