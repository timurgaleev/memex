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
]);

const FORBIDDEN_MCP_TOOLS_FROM_PUBLIC: ReadonlySet<string> = new Set([
  "index",
  "log_friction",
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

function isPublicRequest(req: Request): boolean {
  return req.headers.get("Cf-Connecting-Ip") !== null;
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
  if (auth !== expected) {
    return {
      allow: false,
      status: 401,
      reason: "missing or invalid bearer token",
    };
  }

  return { allow: true, isPublic: true };
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
};
