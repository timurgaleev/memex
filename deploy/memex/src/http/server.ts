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
  evaluatePublicGuard,
  evaluateInternalAuth,
  isPublicMcpToolForbidden,
} from "./public_guard.ts";
import { verifyOAuthToken } from "./oauth.ts";
import type { OAuthConfig } from "./oauth.ts";
import { makeMcpHandler } from "../mcp/http_transport.ts";
import { RateLimiter } from "../mcp/rate_limit.ts";
import { createAdminAuth, type AdminAuth } from "./admin.ts";
import { handleAdminApi } from "./admin-api.ts";
import { serveAdminStatic } from "./admin-static.ts";
import { handleAdminEventsRoute } from "./admin-events.ts";
import type { AuthInfo } from "../core/auth-info.ts";

/**
 * The server-side entitlement floor for an OAuth subject. Grants live in the
 * `source_grants` table (migration 048), keyed by JWT `sub`, and are the ONLY
 * trusted source of a subject's write source + federated read set — token
 * claims are deliberately ignored for tenancy. Returns `null` for an
 * un-provisioned subject (caller falls back to unscoped public-redacted read).
 */
interface SourceGrantRow {
  source_id: string | null;
  federated_read: string[];
}

async function lookupSourceGrant(
  storage: Storage,
  sub: string,
): Promise<SourceGrantRow | null> {
  const res = await storage.engine().query<SourceGrantRow>(
    "SELECT source_id, federated_read FROM source_grants WHERE sub = $1",
    [sub],
  );
  return res.rows[0] ?? null;
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
   * Optional OAuth/JWT bearer config (Wave 6). Default-OFF: when absent or
   * `enabled !== true`, the JWT path is never invoked and auth is byte-identical
   * to the static-bearer behaviour. A validated token maps to the PUBLIC
   * (redacted) scope only — never internal.
   */
  oauthConfig?: OAuthConfig;
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
    fetch: async (req) => {
      const url = new URL(req.url);

      let guard = evaluatePublicGuard(req, url, guardOpts);
      let oauthAuth: AuthInfo | undefined;
      if (!guard.allow) {
        // OAuth fallback (default-OFF). Only when enabled, only on a 401
        // (public request, bearer present-but-wrong / missing) — never on a
        // 403 write-path or 503 unconfigured. A valid JWT maps to the PUBLIC
        // redacted scope (isPublic:true), never internal. Fail-closed: any
        // verify error leaves the original rejection intact.
        if (opts.oauthConfig?.enabled === true && guard.status === 401) {
          const m = /^Bearer (.+)$/.exec(
            req.headers.get("Authorization") ?? "",
          );
          if (m && m[1]) {
            const bearer = m[1];
            const r = await verifyOAuthToken(bearer, opts.oauthConfig);
            if (r.ok) {
              guard = { allow: true, isPublic: true };
              // SECURITY: the source grant is NEVER trusted from token claims —
              // `r.sourceId` / `r.allowedSources` are user-influenceable. The
              // IdP only proves identity (sub); the entitlement floor lives
              // server-side in `source_grants`, keyed by sub. Look it up.
              const grant = await lookupSourceGrant(opts.storage, r.sub);
              oauthAuth = {
                token: bearer,
                clientId: r.sub,
                scopes: ["read"],
                // No grant row → leave sourceId/allowedSources undefined, so
                // effectiveReadSourceIds() => undefined => unscoped public-
                // redacted read: the safe default for an un-provisioned subject
                // (still gated by isPublic redaction, never widened).
                ...(grant?.source_id != null
                  ? { sourceId: grant.source_id }
                  : {}),
                ...(grant?.federated_read != null
                  ? { allowedSources: grant.federated_read }
                  : {}),
                isPublic: true,
              };
            }
          }
        }
        if (!guard.allow) {
          return Response.json(
            { ok: false, error: guard.reason },
            { status: guard.status },
          );
        }
      }

      if (url.pathname === "/health" && req.method === "GET") {
        return handleHealth(opts.storage);
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
