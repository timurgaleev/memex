/**
 * POST /search — hybrid retrieve over the indexed corpus.
 *
 * Body: { q: string, k?: number }
 * Returns: { ok, hits: SearchHit[] }
 *
 * Public-ingress responses redact note bodies by default (a leaked
 * bearer must not exfil the entire vault). Bodies opt back in via
 * `MEMEX_PUBLIC_READ_BODIES=1`. Internal callers always see full
 * bodies — the telegram-bridge needs them for RAG synthesis.
 */
import type { Storage } from "../core/storage.ts";
import { hybridSearch } from "../core/search/index.ts";
import { makeCaptureCallback } from "../core/eval-capture.ts";
import { parseJsonBody } from "./body_limit.ts";
import { PUBLIC_GUARD_INTERNALS } from "./public_guard.ts";
// Body redaction lives in core (shared with the MCP dispatch layer).
// Imported for local use here and re-exported so existing importers of
// `redactBodies` from this module (tests, dispatch) keep working.
import { redactBodies } from "../core/public_redaction.ts";
export { redactBodies };

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

// Allowlist of fields safe to return on public ingress. Anything else
// — including future fields like `raw_text` or `body_md` that don't
// exist yet — gets stripped by default. Fail-safe rather than
// fail-open: a new body-ish field added to SearchHit cannot
// accidentally leak just because we forgot to extend a denylist.
const PUBLIC_SAFE_FIELDS = new Set([
  "title",
  "sourcePath",
  "score",
  "documentId",
  "chunkId",
  "kind",
  "rank",
]);

/**
 * Strip every field from each hit that isn't in `PUBLIC_SAFE_FIELDS`.
 * Exported so unit tests can exercise it without standing up the full
 * Bedrock + Storage stack.
 */
export function redactBodies<T extends Record<string, unknown>>(hits: readonly T[]): T[] {
  return hits.map((h) => {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(h)) {
      if (PUBLIC_SAFE_FIELDS.has(k)) {
        out[k] = h[k];
      }
    }
    return out as T;
  });
}

export async function handleSearch(
  storage: Storage,
  req: Request,
  isPublic = false,
): Promise<Response> {
  const parsed = await parseJsonBody<SearchRequest>(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
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
    // Redact note bodies on public ingress unless explicitly opted-in.
    // Default returns only title + sourcePath + score so a leaked
    // bearer cannot exfil the entire vault contents in one request.
    const shouldRedact =
      isPublic && !PUBLIC_GUARD_INTERNALS.publicReadBodiesAllowed();
    const out = shouldRedact ? redactBodies(hits as Record<string, unknown>[]) : hits;
    return Response.json({ ok: true, hits: out });
  } catch (e) {
    // Internal callers get the raw error for debugging; public callers
    // get a generic 500 so backend paths / SQL identifiers / missing
    // tables don't leak via error text.
    const msg = isPublic
      ? "search backend error"
      : e instanceof Error
        ? e.message
        : String(e);
    return Response.json({ ok: false, error: msg }, { status: 500 });
  }
}
