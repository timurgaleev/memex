/**
 * Public-request guard — enforces bearer auth + write-protection on
 * requests that arrived through the public Cloudflare Tunnel ingress.
 *
 * Detection: a request from the Cloudflare edge carries a
 * `Cf-Connecting-Ip` header (the real client IP). Internal Docker
 * traffic from the openclaw container hits the bridge network
 * directly and never goes through Cloudflare, so it lacks this header.
 *
 * Public-request rules:
 *   1. `/health` GET — open (used by uptime probes).
 *   2. Anything else — requires `Authorization: Bearer <token>`.
 *      Token comes from `MEMEX_PUBLIC_BEARER` env (populated by
 *      fetch-secrets.sh from the `openclaw/memex-public-bearer`
 *      Secrets Manager entry).
 *   3. **Mutating routes are rejected by default** even with a valid
 *      bearer (POST /index, POST /friction, MCP tools/call
 *      name=index|log_friction). Set env `MEMEX_PUBLIC_WRITE=1`
 *      to opt the public route into write access — pair this with
 *      daily bearer rotation (`scripts/rotate-memex-public-bearer.sh`)
 *      so a leaked token gets invalidated within 24h.
 *
 * If the env has no bearer token AND the request is public → 503.
 * Operators MUST configure the secret before exposing the route.
 */

import { timingSafeEqual } from "node:crypto";

export interface PublicGuardOptions {
  /** Bearer token. If undefined, every public request is rejected. */
  bearerToken?: string;
}

export interface GuardDecision {
  allow: true;
  /** True iff this request came from the public Cloudflare ingress. */
  isPublic: boolean;
}

export interface GuardRejection {
  allow: false;
  status: number;
  reason: string;
}

const FORBIDDEN_PATHS_FROM_PUBLIC = new Set([
  "/index",
  "/friction",
  "/pages/put",
  "/pages/append",
  "/pages/delete",
  "/graph/link",
  "/graph/unlink",
  "/entities/facts/add",
  "/timeline/add",
  "/jobs/submit",
  "/jobs/cancel",
]);

const FORBIDDEN_MCP_TOOLS_FROM_PUBLIC: ReadonlySet<string> = new Set([
  "index",
  "log_friction",
  "page_put",
  "page_append",
  "page_delete",
  "link",
  "unlink",
  "add_fact",
  "add_timeline_event",
  "jobs_submit",
  "jobs_cancel",
]);

/**
 * When `MEMEX_PUBLIC_WRITE=1` is set in the runtime env, the
 * public route accepts write traffic too. Read-once at module init
 * — flip the env + restart the container to change.
 */
function publicWriteAllowed(): boolean {
  const v = (process.env["MEMEX_PUBLIC_WRITE"] ?? "").trim();
  return v === "1" || v.toLowerCase() === "true";
}

function publicReadBodiesAllowed(): boolean {
  const v = (process.env["MEMEX_PUBLIC_READ_BODIES"] ?? "").trim();
  return v === "1" || v.toLowerCase() === "true";
}

function isPublicRequest(req: Request): boolean {
  // Public ingress is detected by Cloudflare's `Cf-Connecting-Ip`
  // header. An empty value is treated as still-public (a defence
  // against an attacker setting the header to "" hoping we treat them
  // as internal); only a missing header counts as internal.
  return req.headers.get("Cf-Connecting-Ip") !== null;
}

/**
 * Internal-route auth — requests that the public guard waves through
 * as "internal" must still carry a matching shared token. Without
 * this check, any peer on the docker bridge (compromised sibling
 * container or future host bind on :18790) could write to the index
 * via POST /index with no auth at all. The shared secret is loaded
 * from `MEMEX_INTERNAL_TOKEN` env (populated by fetch-secrets.sh
 * from `<secrets_prefix>/memex-internal-token`).
 *
 * Fail-closed: when the token is configured but a request lacks the
 * matching `Authorization: Bearer <internal-token>` header, the
 * request is rejected with 401. When the env var is unset the gate
 * is open (legacy single-node installs); operators are urged to
 * configure the secret.
 */
export interface InternalAuthOptions {
  internalToken?: string;
}

export function evaluateInternalAuth(
  req: Request,
  opts: InternalAuthOptions,
): GuardDecision | GuardRejection {
  if (!opts.internalToken || opts.internalToken.length === 0) {
    // Legacy fall-through. Loud warning logged once at startup; do
    // not also log per request (would spam at MCP traffic rates).
    return { allow: true, isPublic: false };
  }
  const auth = req.headers.get("Authorization") ?? "";
  const expected = `Bearer ${opts.internalToken}`;
  if (!timingSafeEqualStrings(auth, expected)) {
    return {
      allow: false,
      status: 401,
      reason: "internal endpoint requires X-Authorization shared token",
    };
  }
  return { allow: true, isPublic: false };
}

export function evaluatePublicGuard(
  req: Request,
  url: URL,
  opts: PublicGuardOptions,
): GuardDecision | GuardRejection {
  const isPublic = isPublicRequest(req);
  if (!isPublic) {
    return { allow: true, isPublic: false };
  }

  // Public — apply guard.
  if (url.pathname === "/health" && req.method === "GET") {
    // Open probe. No bearer required.
    return { allow: true, isPublic: true };
  }

  if (
    FORBIDDEN_PATHS_FROM_PUBLIC.has(url.pathname) &&
    !publicWriteAllowed()
  ) {
    return {
      allow: false,
      status: 403,
      reason: `route ${url.pathname} is internal-only (set MEMEX_PUBLIC_WRITE=1 to opt in)`,
    };
  }

  if (!opts.bearerToken || opts.bearerToken.length === 0) {
    return {
      allow: false,
      status: 503,
      reason: "public bearer token not configured",
    };
  }

  const auth = req.headers.get("Authorization") ?? "";
  const expected = `Bearer ${opts.bearerToken}`;
  if (!timingSafeEqualStrings(auth, expected)) {
    return {
      allow: false,
      status: 401,
      reason: "missing or invalid bearer token",
    };
  }

  return { allow: true, isPublic: true };
}

/**
 * Constant-time string comparison. A simple `a !== b` short-circuits on
 * the first differing byte, leaking the prefix-match length to a
 * timing-sensitive attacker — relevant because the public bearer is
 * fronted by Cloudflare. We compare two equal-length Buffers via
 * Node's timingSafeEqual; if the lengths differ we still do a dummy
 * compare so the timing remains uniform.
 */
function timingSafeEqualStrings(a: string, b: string): boolean {
  // Bearer tokens are ASCII (URL-safe random alphanumerics), so UTF-8
  // byte length == char count. Buffer.from is constant-time-ish per
  // input byte; the dummy compare below masks the secret's length.
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) {
    // Burn cycles against a buffer matching the SECRET's length, not
    // the attacker's. Attacker can vary their own input length but the
    // mismatch path's compute is always proportional to |b|.
    const dummy = Buffer.alloc(bBuf.length);
    timingSafeEqual(dummy, dummy);
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}

/**
 * MCP tools/call extra check — even with a valid bearer, mutating
 * tools are rejected from public requests by default. When
 * `MEMEX_PUBLIC_WRITE=1` the gate opens.
 */
export function isPublicMcpToolForbidden(toolName: string): boolean {
  if (publicWriteAllowed()) return false;
  return FORBIDDEN_MCP_TOOLS_FROM_PUBLIC.has(toolName);
}

export const PUBLIC_GUARD_INTERNALS = {
  isPublicRequest,
  FORBIDDEN_PATHS_FROM_PUBLIC,
  FORBIDDEN_MCP_TOOLS_FROM_PUBLIC,
  publicReadBodiesAllowed,
};
