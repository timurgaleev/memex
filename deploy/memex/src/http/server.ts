/**
 * Bun HTTP server — routes requests, owns the Storage instance lifetime.
 *
 * The surface is deliberately TWO routes (MCP cleanup, Phase A.7):
 *   GET  /health       — liveness + db stats (open on public ingress)
 *   POST /mcp          — MCP JSON-RPC 2.0; all read/write capability lives
 *                        here via `tools/call`. Public callers can't
 *                        discover or invoke the write tools; internal
 *                        write tools require `MEMEX_INTERNAL_TOKEN`.
 *
 * The legacy REST routes (`/index`, `/search`, `/backlinks`, `/friction`,
 * `/pages/*`, `/graph/*`, `/entities/*`, `/timeline/*`, `/jobs/*`) were
 * removed in A.7 — every one of them is reachable through `/mcp`.
 *
 * Public requests are detected via the `Cf-Connecting-Ip` header set by
 * cloudflared. Bearer auth is required for any non-`/health` public
 * request — see `http/public_guard.ts`.
 */
import type { Storage } from "../core/storage.ts";
import { handleHealth } from "./health.ts";
import {
  handleOAuthMetadataRoute,
  OAUTH_METADATA_PATH,
} from "./oauth-metadata.ts";
import {
  evaluatePublicGuard,
  evaluateInternalAuth,
  isPublicMcpToolForbidden,
} from "./public_guard.ts";
import {
  OAuthProvider,
  InvalidTokenError,
} from "../core/oauth-provider.ts";
import { makeMcpHandler } from "../mcp/http_transport.ts";
import { RateLimiter } from "../mcp/rate_limit.ts";
import { createAdminAuth, type AdminAuth } from "./admin.ts";
import { handleAdminApi } from "./admin-api.ts";
import { serveAdminStatic } from "./admin-static.ts";
import { handleAdminEventsRoute } from "./admin-events.ts";
import type { AuthInfo } from "../core/auth-info.ts";

/**
 * POST /token — OAuth 2.1 client_credentials grant (RFC 6749 §4.4). Accepts a
 * form-encoded or JSON body with `grant_type=client_credentials`, `client_id`,
 * `client_secret`, optional `scope`. Returns the RFC 6749 §5.1 token payload, or
 * a §5.2 error. Any client/secret failure collapses to a single `invalid_client`
 * 401 so the endpoint never reveals whether a client_id exists.
 */
async function handleTokenRoute(
  req: Request,
  provider: OAuthProvider,
): Promise<Response> {
  let params: URLSearchParams;
  try {
    const ct = req.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      const j = (await req.json()) as Record<string, unknown>;
      params = new URLSearchParams();
      for (const [k, v] of Object.entries(j)) {
        if (typeof v === "string") params.set(k, v);
      }
    } else {
      params = new URLSearchParams(await req.text());
    }
  } catch {
    return Response.json(
      { error: "invalid_request", error_description: "malformed body" },
      { status: 400 },
    );
  }

  if (params.get("grant_type") !== "client_credentials") {
    return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
  }
  const clientId = params.get("client_id");
  const clientSecret = params.get("client_secret");
  if (!clientId || !clientSecret) {
    return Response.json(
      {
        error: "invalid_client",
        error_description: "client_id and client_secret are required",
      },
      { status: 401 },
    );
  }

  try {
    const tokens = await provider.exchangeClientCredentials(
      clientId,
      clientSecret,
      params.get("scope") ?? undefined,
    );
    return Response.json(tokens, {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    // Never distinguish unknown-client from bad-secret from wrong-grant.
    return Response.json({ error: "invalid_client" }, { status: 401 });
  }
}

export interface ServerOptions {
  host: string;
  port: number;
  storage: Storage;
  /** Mount POST /mcp. Default true. */
  mcpEnabled?: boolean;
  /** Per-IP request limit. Default 60/min (capacity 30, refill 1/s). */
  mcpRateLimitPerMinute?: number;
  /**
   * Bearer token required on the public Cloudflare ingress. Wire from
   * the `MEMEX_PUBLIC_BEARER` env / `<secrets_prefix>/memex-public-bearer`
   * secret. When unset, internal requests still flow but every public
   * request returns 503 — fail-closed.
   */
  publicBearerToken?: string;
  /**
   * Shared secret required to call MCP write tools (`index`,
   * `log_friction`, `page_*`, `link`/`unlink`, `add_*`, `jobs_*`) on the
   * internal `/mcp` path. Defends the docker-bridge surface from a
   * compromised sibling container. Wire from `MEMEX_INTERNAL_TOKEN` env /
   * `<secrets_prefix>/memex-internal-token`. When unset, internal write
   * tools stay open (legacy single-node behaviour) — a single startup
   * warning is logged; operators should configure the secret.
   */
  internalToken?: string;
  /**
   * memex's own OAuth 2.1 provider (client_credentials), wired from
   * `config.auth.selfIssued.enabled`. When set, the server mounts POST `/token`
   * and verifies self-issued `memex_at_…` bearer tokens on the `/mcp` ingress,
   * scoping each request to its registered `oauth_clients` row. This is the
   * reference-faithful auth path that replaces the external-IdP JWT overlay.
   */
  oauthProvider?: OAuthProvider;
  /**
   * Admin surface bootstrap token (increment A1). When set, the `/admin` auth
   * routes are mounted: the operator/agent uses this token to log in or mint a
   * magic link. Omitted → no admin surface.
   */
  adminBootstrapToken?: string;
  /** Public base URL for minted admin magic-links (falls back to the request host). */
  publicUrl?: string;
}

export interface ServerHandle {
  stop: () => Promise<void>;
  port: number;
}

export function startServer(opts: ServerOptions): ServerHandle {
  const mcpEnabled = opts.mcpEnabled !== false;
  const mcpHandler = mcpEnabled
    ? makeMcpHandler({
        storage: opts.storage,
        rateLimiter: opts.mcpRateLimitPerMinute
          ? new RateLimiter({
              refillPerSecond: opts.mcpRateLimitPerMinute / 60,
              capacity: Math.max(10, Math.floor(opts.mcpRateLimitPerMinute / 2)),
            })
          : undefined,
        forbidPublicTool: isPublicMcpToolForbidden,
      })
    : null;

  const guardOpts: { bearerToken?: string } = {};
  if (opts.publicBearerToken) guardOpts.bearerToken = opts.publicBearerToken;

  // Per-IP throttle for the unauthenticated POST /token endpoint — blunts
  // client_secret brute-force and the DB-load DoS it would otherwise allow
  // (10/min, capacity 10). Only created when the self-issued provider is on.
  const tokenRateLimiter = opts.oauthProvider
    ? new RateLimiter({ capacity: 10, refillPerSecond: 10 / 60 })
    : null;

  let adminAuth: AdminAuth | null = null;
  if (opts.adminBootstrapToken && opts.adminBootstrapToken.length > 0) {
    adminAuth = createAdminAuth({
      bootstrapToken: opts.adminBootstrapToken,
      ...(opts.publicUrl ? { publicUrl: opts.publicUrl } : {}),
    });
  }
  const internalAuthOpts: { internalToken?: string } = {};
  if (opts.internalToken) {
    internalAuthOpts.internalToken = opts.internalToken;
  } else {
    console.warn(
      "[memex] WARNING: MEMEX_INTERNAL_TOKEN not configured — MCP write " +
        "tools (index, log_friction, page_*, link, add_*, jobs_*) are open " +
        "to any peer on the docker bridge. Configure the token via " +
        "<secrets_prefix>/memex-internal-token + fetch-secrets.sh.",
    );
  }

  const server = Bun.serve({
    hostname: opts.host,
    port: opts.port,
    fetch: async (req, server) => {
      const url = new URL(req.url);

      // POST /token — OAuth 2.1 client_credentials endpoint. Authenticates via
      // the client_id/client_secret in the body (NOT the public bearer), so it
      // runs BEFORE the bearer guard. Only mounted when the self-issued provider
      // is enabled. Per-IP rate-limited (brute-force / DoS defense).
      if (
        url.pathname === "/token" &&
        req.method === "POST" &&
        opts.oauthProvider
      ) {
        const ip = server.requestIP(req)?.address ?? "unknown";
        if (tokenRateLimiter && !tokenRateLimiter.allow(ip)) {
          return Response.json(
            { error: "slow_down", error_description: "rate limit exceeded" },
            { status: 429, headers: { "Retry-After": "60" } },
          );
        }
        return handleTokenRoute(req, opts.oauthProvider);
      }

      let guard = evaluatePublicGuard(req, url, guardOpts);
      let oauthAuth: AuthInfo | undefined;
      if (!guard.allow) {
        // Self-issued provider (preferred path). A `memex_at_…` token is opaque
        // (not a JWS), so it must be verified here, not by the JWT verifier. On
        // success the request is a TRUSTED registered client scoped to its own
        // `oauth_clients` row — unredacted read within that source scope
        // (isPublic:false); writes stay gated by the internal-token path.
        if (opts.oauthProvider && guard.status === 401) {
          const m = /^Bearer (.+)$/.exec(
            req.headers.get("Authorization") ?? "",
          );
          if (m && m[1] && m[1].startsWith("memex_at_")) {
            try {
              const info = await opts.oauthProvider.verifyAccessToken(m[1]);
              guard = { allow: true, isPublic: false };
              oauthAuth = {
                token: info.token,
                clientId: info.clientId,
                scopes: info.scopes,
                ...(info.sourceId != null ? { sourceId: info.sourceId } : {}),
                ...(info.allowedSources != null
                  ? { allowedSources: info.allowedSources }
                  : {}),
                isPublic: false,
              };
            } catch (e) {
              // InvalidTokenError = a bad/expired token: fall through to the
              // public path silently. ANY OTHER error (DB outage, provider bug)
              // is still fail-closed to public, but MUST be logged — otherwise an
              // incident is indistinguishable from a routine bad token.
              if (!(e instanceof InvalidTokenError)) {
                console.error(
                  "[memex] self-issued token verification error:",
                  e,
                );
              }
            }
          }
        }
      }
      if (!guard.allow) {
        return Response.json(
          { ok: false, error: guard.reason },
          { status: guard.status },
        );
      }

      if (url.pathname === "/health" && req.method === "GET") {
        return handleHealth(opts.storage);
      }
      // OAuth 2.1 discovery (RFC 8414) — public, lets a standard MCP OAuth
      // client auto-configure from memex's own public base URL. The guard
      // above already exempts this path from the bearer requirement.
      if (url.pathname === OAUTH_METADATA_PATH && req.method === "GET") {
        return handleOAuthMetadataRoute(url, opts.publicUrl);
      }
      if (url.pathname === "/mcp" && mcpHandler) {
        // Evaluate the internal-token gate once per request; the handler
        // enforces it only for write tools on the internal path (read
        // tools and public traffic ignore it). `allow` is true when the
        // token is unconfigured (legacy fallthrough) or correctly sent.
        const ia = evaluateInternalAuth(req, internalAuthOpts);
        return mcpHandler(req, {
          isPublic: guard.isPublic,
          internalAuthOk: ia.allow,
          ...(oauthAuth !== undefined ? { authInfo: oauthAuth } : {}),
        });
      }
      if (adminAuth && (url.pathname === "/admin" || url.pathname.startsWith("/admin/"))) {
        // A1 auth routes, then A2 data/provisioning routes (each gates on
        // requireAdmin itself). The embedded SPA (B/C) dispatches here later.
        const r = await adminAuth.handleAuthRoute(req, url);
        if (r) return r;
        const r2 = await handleAdminApi(req, url, {
          storage: opts.storage,
          requireAdmin: adminAuth.requireAdmin,
        });
        if (r2) return r2;
        // SSE live-activity feed (deferred #2) — requireAdmin-gated.
        const rsse = handleAdminEventsRoute(req, adminAuth.requireAdmin);
        if (rsse) return rsse;
        // C: the built SPA (static dist + index.html fallback). Auth + the data
        // API above win; everything else under /admin is the front-end. GET only.
        if (req.method === "GET") {
          const r3 = await serveAdminStatic(url);
          if (r3) return r3;
        }
      }
      return new Response("Not Found", { status: 404 });
    },
    error(err) {
      console.error("[memex] server error:", err);
      return new Response("Internal Server Error", { status: 500 });
    },
  });
  const flags = [
    mcpEnabled ? "MCP" : "",
    opts.publicBearerToken ? "public-bearer" : "",
  ]
    .filter(Boolean)
    .join(", ");
  console.log(
    `[memex] listening on http://${opts.host}:${opts.port}${flags ? ` (${flags})` : ""}`,
  );
  return {
    port: server.port,
    stop: async () => {
      await server.stop(true);
    },
  };
}
