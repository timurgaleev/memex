/**
 * CORS handling for the OAuth + MCP surface (`/mcp`, `/token`, `/authorize`,
 * `/register`, `/revoke`) — default-DENY.
 *
 * Posture: every cross-origin request to these endpoints is
 * rejected unless the operator explicitly allowlists the origin via
 * `MEMEX_HTTP_CORS_ORIGIN` (comma-separated origins). Without the env var
 * no `Access-Control-Allow-Origin` header is ever emitted, so a browser
 * refuses the response — a web origin can't complete a token exchange from
 * a logged-in operator's browser. Same-origin and non-browser callers send
 * no `Origin` header and are unaffected.
 *
 * Preflight (`OPTIONS`) is answered BEFORE auth: preflights carry no
 * credentials by design, so routing them through the bearer guard would
 * 401 every browser client. The response is 204 either way; only an
 * allowlisted Origin gets the `Access-Control-*` grant headers.
 */

/** Paths that participate in CORS handling. */
export const CORS_PATHS: ReadonlySet<string> = new Set([
  "/mcp",
  "/token",
  "/authorize",
  "/register",
  "/revoke",
]);

const ALLOWED_METHODS = "GET, POST, OPTIONS";
const ALLOWED_HEADERS = "Content-Type, Authorization, Accept";

/**
 * Parse `MEMEX_HTTP_CORS_ORIGIN` into an origin allowlist. Returns null when
 * unset/empty — callers MUST treat null as "deny all cross-origin".
 */
export function parseCorsAllowlist(
  env: string | undefined = process.env.MEMEX_HTTP_CORS_ORIGIN,
): Set<string> | null {
  if (!env) return null;
  const origins = env
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return origins.length === 0 ? null : new Set(origins);
}

/** Answer an OPTIONS preflight. 204 always; grant headers only when the
 *  request Origin is allowlisted (echoed per RFC 6454, never `*`). */
export function corsPreflightResponse(
  req: Request,
  allowlist: Set<string> | null,
): Response {
  const headers = new Headers({ Vary: "Origin" });
  const origin = req.headers.get("Origin");
  if (origin && allowlist !== null && allowlist.has(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Methods", ALLOWED_METHODS);
    headers.set("Access-Control-Allow-Headers", ALLOWED_HEADERS);
    headers.set("Access-Control-Max-Age", "86400");
  }
  return new Response(null, { status: 204, headers });
}

/** Stamp the allow-origin grant onto an actual (non-preflight) response when
 *  the request Origin is allowlisted. No-op otherwise. */
export function applyCorsHeaders(
  res: Response,
  req: Request,
  allowlist: Set<string> | null,
): Response {
  const origin = req.headers.get("Origin");
  if (!origin || allowlist === null || !allowlist.has(origin)) return res;
  res.headers.set("Access-Control-Allow-Origin", origin);
  res.headers.append("Vary", "Origin");
  return res;
}
