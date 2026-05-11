/**
 * POST /search — hybrid retrieve over the indexed corpus.
 *
 * Body: { q: string, k?: number }
 * Returns: { ok, hits: SearchHit[] }
 */
import type { Storage } from "../core/storage.ts";
import { hybridSearch } from "../core/search/index.ts";
import { makeCaptureCallback } from "../core/eval-capture.ts";

interface SearchRequest {
  q: string;
  k?: number;
}

function isSearchReq(b: unknown): b is SearchRequest {
  return (
    typeof b === "object" &&
    b !== null &&
    "q" in b &&
    typeof (b as SearchRequest).q === "string"
  );
}

export async function handleSearch(
  storage: Storage,
  req: Request,
): Promise<Response> {
  let body: SearchRequest;
  try {
    body = (await req.json()) as SearchRequest;
  } catch {
    return Response.json(
      { ok: false, error: "request body must be valid JSON" },
      { status: 400 },
    );
  }
  if (!isSearchReq(body)) {
    return Response.json(
      { ok: false, error: "body must be { q: string, k?: number }" },
      { status: 400 },
    );
  }
  const k =
    typeof body.k === "number" && body.k >= 1 && body.k <= 100
      ? Math.floor(body.k)
      : undefined;

  try {
    const onCapture = makeCaptureCallback(storage.engine(), storage.config(), {
      toolName: "http.search",
      remote: false,
    });
    const opts: Parameters<typeof hybridSearch>[2] = {};
    if (k !== undefined) opts.k = k;
    if (onCapture) opts.onCapture = onCapture;
    const hits = await hybridSearch(storage, body.q, opts);
    return Response.json({ ok: true, hits });
  } catch (e) {
    return Response.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
