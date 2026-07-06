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
  handleProtectedResourceRoute,
  resolveIssuer,
  wwwAuthenticateChallenge,
  OAUTH_METADATA_PATH,
  OAUTH_PROTECTED_RESOURCE_PATH,
} from "./oauth-metadata.ts";
import {
  CORS_PATHS,
  parseCorsAllowlist,
  corsPreflightResponse,
  applyCorsHeaders,
} from "./cors.ts";
import { handleIngestRoute } from "./ingest.ts";
import {
  evaluatePublicGuard,
  evaluateInternalAuth,
  isPublicMcpToolForbidden,
} from "./public_guard.ts";
import {
  OAuthProvider,
  InvalidTokenError,
} from "../core/oauth-provider.ts";
import {
  handleTokenRoute,
  handleAuthorizeRoute,
  handleRegisterRoute,
  handleRevokeRoute,
} from "./oauth-endpoints.ts";
import { makeMcpHandler } from "../mcp/http_transport.ts";
import { RateLimiter } from "../mcp/rate_limit.ts";
import { createAdminAuth, type AdminAuth } from "./admin.ts";
import { handleAdminApi } from "./admin-api.ts";
import { serveAdminStatic } from "./admin-static.ts";
import { handleAdminEventsRoute } from "./admin-events.ts";
import type { AuthInfo } from "../core/auth-info.ts";

/** RFC 6749 §5.2-style throttle response for the rate-limited OAuth endpoints. */
function rateLimited(): Response {
  return Response.json(
    { error: "slow_down", error_description: "rate limit exceeded" },
    { status: 429, headers: { "Retry-After": "60" } },
  );
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

  // Per-IP throttle for the unauthenticated OAuth endpoints (/token,
  // /authorize, /revoke) — blunts client_secret brute-force and the DB-load DoS
  // they would otherwise allow (10/min, capacity 10). A separate, stricter
  // limiter guards /register (Dynamic Client Registration), which each request
  // INSERTs a durable oauth_clients row, so it warrants a tighter cap (5/min).
  // Both are only created when the self-issued provider is on.
  const tokenRateLimiter = opts.oauthProvider
    ? new RateLimiter({ capacity: 10, refillPerSecond: 10 / 60 })
    : null;
  const registerRateLimiter = opts.oauthProvider
    ? new RateLimiter({ capacity: 5, refillPerSecond: 5 / 60 })
    : null;
  // POST /ingest webhook capture — 100 events / 10 s per IP (reference cap).
  const ingestRateLimiter = new RateLimiter({ capacity: 100, refillPerSecond: 10 });
  // Default-deny CORS allowlist for the OAuth + MCP surface (read once at boot).
  const corsAllowlist = parseCorsAllowlist();

  let adminAuth: AdminAuth | null = null;
  if (opts.adminBootstrapToken && opts.adminBootstrapToken.length > 0) {
    adminAuth = createAdminAuth({
      bootstrapToken: opts.adminBootstrapToken,
      ...(opts.publicUrl ? { publicUrl: opts.publicUrl } : {}),
    });
  }
  // Opt-in strict OAuth: require a logged-in operator on /authorize. Default OFF
  // (auto-approve, reference parity) — see the /authorize handler below.
  const oauthRequireLogin =
    ((process.env.MEMEX_OAUTH_REQUIRE_LOGIN ?? "").trim().toLowerCase() === "1" ||
      (process.env.MEMEX_OAUTH_REQUIRE_LOGIN ?? "").trim().toLowerCase() === "true");
  // Dynamic Client Registration is OFF by default (reference parity: the
  // reference's `--enable-dcr`). With it off, /register is unavailable and the
  // discovery doc omits registration_endpoint, so the ONLY way a client exists is
  // an operator creating it via `memex auth register-client` — nobody can
  // self-register a client over the network. Enable with MEMEX_ENABLE_DCR=1.
  const dcrEnabled =
    ((process.env.MEMEX_ENABLE_DCR ?? "").trim().toLowerCase() === "1" ||
      (process.env.MEMEX_ENABLE_DCR ?? "").trim().toLowerCase() === "true");
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

      // CORS preflight — answered BEFORE auth: preflights carry no
      // credentials by design, so the bearer guard would 401 every browser
      // client. 204 either way; grant headers only for allowlisted origins.
      if (req.method === "OPTIONS" && CORS_PATHS.has(url.pathname)) {
        return corsPreflightResponse(req, corsAllowlist);
      }

      const handle = async (): Promise<Response> => {

      let guard = evaluatePublicGuard(req, url, guardOpts);
      let oauthAuth: AuthInfo | undefined;
      if (!guard.allow) {
        // Self-issued provider (preferred path). A `memex_at_…` token is opaque
        // (not a JWS), so it must be verified here, not by the JWT verifier. On
        // success the request is a TRUSTED registered client scoped to its own
        // `oauth_clients` row — unredacted read within that source scope
        // (isPublic:false); writes stay gated by the internal-token path.
        // Every bearer is offered to the verifier (reference parity: /mcp sits
        // behind requireBearerAuth with no prefix filter) — the provider's
        // fallback resolves legacy access_tokens PATs (`memex_…`), whose tenant
        // scope comes from `permissions.source_id`. A non-token string just
        // misses both hash lookups and falls through to the 401 below.
        if (opts.oauthProvider && guard.status === 401) {
          const m = /^Bearer (.+)$/.exec(
            req.headers.get("Authorization") ?? "",
          );
          if (m && m[1]) {
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
                ...(info.takesHolders != null
                  ? { takesHolders: info.takesHolders }
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
        // RFC 9728 §5.1: a 401 on the MCP resource carries a WWW-Authenticate
        // challenge pointing at the protected-resource metadata, so a
        // standards-aware OAuth client can bootstrap the flow unattended.
        const headers: Record<string, string> = {};
        if (url.pathname === "/mcp" && guard.status === 401) {
          headers["WWW-Authenticate"] = wwwAuthenticateChallenge(
            resolveIssuer(url, opts.publicUrl),
          );
        }
        return Response.json(
          { ok: false, error: guard.reason },
          { status: guard.status, headers },
        );
      }

      if (url.pathname === "/health" && req.method === "GET") {
        return handleHealth(opts.storage);
      }
      // OAuth 2.1 discovery (RFC 8414) — public, lets a standard MCP OAuth
      // client auto-configure from memex's own public base URL. The guard
      // above already exempts this path from the bearer requirement.
      if (url.pathname === OAUTH_METADATA_PATH && req.method === "GET") {
        return handleOAuthMetadataRoute(url, opts.publicUrl, dcrEnabled);
      }
      // RFC 9728 protected-resource metadata — public for the same reason.
      if (url.pathname === OAUTH_PROTECTED_RESOURCE_PATH && req.method === "GET") {
        return handleProtectedResourceRoute(url, opts.publicUrl);
      }
      // OAuth 2.1 authorization endpoints. Public (exempted in the guard) —
      // authenticated by client_id/secret + PKCE downstream, NOT the public
      // bearer. Only mounted when the self-issued provider is enabled; each is
      // per-IP rate-limited (brute-force / DCR-abuse / DoS defense).
      if (opts.oauthProvider) {
        const oauthProvider = opts.oauthProvider;
        const ip = server.requestIP(req)?.address ?? "unknown";
        if (url.pathname === "/token" && req.method === "POST") {
          if (tokenRateLimiter && !tokenRateLimiter.allow(ip)) {
            return rateLimited();
          }
          return handleTokenRoute(req, oauthProvider);
        }
        if (url.pathname === "/authorize" && req.method === "GET") {
          if (tokenRateLimiter && !tokenRateLimiter.allow(ip)) {
            return rateLimited();
          }
          // Auto-approve by default (reference parity), so a standard MCP client
          // completes the flow unattended. Opt into the stricter operator-login
          // gate with MEMEX_OAUTH_REQUIRE_LOGIN=1 — then a code is only minted for
          // a logged-in admin (and only when an admin session mechanism exists).
          const requireLogin =
            oauthRequireLogin && adminAuth ? adminAuth.requireAdmin : () => true;
          return handleAuthorizeRoute(req, oauthProvider, requireLogin);
        }
        if (url.pathname === "/register" && req.method === "POST") {
          // DCR off (default) → no self-registration surface at all.
          if (!dcrEnabled) {
            return Response.json(
              {
                error: "not_found",
                error_description:
                  "dynamic client registration is disabled; an operator registers clients via the CLI",
              },
              { status: 404, headers: { "Cache-Control": "no-store" } },
            );
          }
          if (registerRateLimiter && !registerRateLimiter.allow(ip)) {
            return rateLimited();
          }
          return handleRegisterRoute(req, oauthProvider);
        }
        if (url.pathname === "/revoke" && req.method === "POST") {
          if (tokenRateLimiter && !tokenRateLimiter.allow(ip)) {
            return rateLimited();
          }
          return handleRevokeRoute(req, oauthProvider);
        }
      }
      // POST /ingest — webhook capture (OAuth write scope). The guard above
      // resolved OAuth bearers on the public path; internal callers (no
      // Cf-Connecting-Ip) present theirs here, so both ingress classes reach
      // the handler with a resolved identity. Everything else — scope check,
      // byte cap, content-type allowlist, idempotent job — lives in ingest.ts.
      if (url.pathname === "/ingest" && req.method === "POST") {
        let ingestAuth = oauthAuth;
        if (!ingestAuth && opts.oauthProvider) {
          const m = /^Bearer (.+)$/.exec(req.headers.get("Authorization") ?? "");
          if (m && m[1]) {
            try {
              const info = await opts.oauthProvider.verifyAccessToken(m[1]);
              ingestAuth = {
                token: info.token,
                clientId: info.clientId,
                scopes: info.scopes,
                ...(info.sourceId != null ? { sourceId: info.sourceId } : {}),
                ...(info.allowedSources != null
                  ? { allowedSources: info.allowedSources }
                  : {}),
                ...(info.takesHolders != null
                  ? { takesHolders: info.takesHolders }
                  : {}),
                isPublic: guard.isPublic,
              };
            } catch (e) {
              if (!(e instanceof InvalidTokenError)) {
                console.error("[memex] /ingest token verification error:", e);
              }
            }
          }
        }
        const ip =
          req.headers.get("Cf-Connecting-Ip")?.trim() ||
          server.requestIP(req)?.address ||
          "unknown";
        return handleIngestRoute(req, {
          storage: opts.storage,
          ...(ingestAuth !== undefined ? { authInfo: ingestAuth } : {}),
          allowRequest: () => ingestRateLimiter.allow(ip),
          clientIp: ip,
        });
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

      };
      const res = await handle();
      // Stamp the allow-origin grant on actual responses for the OAuth/MCP
      // surface (allowlisted origins only — default deny).
      return CORS_PATHS.has(url.pathname)
        ? applyCorsHeaders(res, req, corsAllowlist)
        : res;
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
