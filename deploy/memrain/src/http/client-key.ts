/**
 * Client identity for every header-keyed rate limiter on the ingress.
 *
 * ONE trust model, shared by the MCP transport, the admin-auth limiter, the
 * OAuth endpoint limiters and the pre-auth token-verification throttle:
 *
 *   1. `Cf-Connecting-Ip` — injected by the Cloudflare edge AND by the Caddy
 *      ingress (`request_header` + `header_up`, scripts/bootstrap.sh). The edge
 *      strips an attacker-supplied copy, so this is the only forwarding header
 *      trusted unconditionally.
 *   2. `X-Forwarded-For` (FIRST hop), then `X-Real-IP` — ONLY when
 *      `MEMEX_HTTP_TRUST_PROXY=1`. Both are attacker-controlled unless a
 *      trusted reverse proxy overwrites them, and a spoofable rate-limit key is
 *      worse than no key at all: the caller rotates values and mints a fresh
 *      bucket per request. Set the flag only behind a proxy that terminates the
 *      client connection and rewrites those headers itself.
 *   3. Otherwise the caller is UNATTRIBUTABLE — `resolveClientIp` returns null.
 *      Callers decide what that means: a coarse shared bucket
 *      (`resolveClientKey` → "internal"), the socket address, or no throttling
 *      at all. Never invent an identity from a spoofable header.
 *
 * The env var is read per call (not memoised at import) so tests can flip it.
 */

export function trustProxyHeaders(): boolean {
  const v = (process.env["MEMEX_HTTP_TRUST_PROXY"] ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
}

/** The caller's IP if one can be trusted, else null (see the module docblock). */
export function resolveClientIp(req: Request): string | null {
  const cfIp = req.headers.get("Cf-Connecting-Ip")?.trim();
  if (cfIp) return cfIp;
  if (trustProxyHeaders()) {
    const first = req.headers.get("X-Forwarded-For")?.split(",")[0]?.trim();
    if (first) return first;
    const real = req.headers.get("X-Real-IP")?.trim();
    if (real) return real;
  }
  return null;
}

/**
 * Rate-limit key for buckets that must charge EVERY request, including
 * unattributable ones. Internal docker-bridge peers carry no forwarding header;
 * metering them as a single entity is the fail-closed choice for those buckets.
 */
export function resolveClientKey(req: Request): string {
  return resolveClientIp(req) ?? "internal";
}
