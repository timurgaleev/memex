/**
 * Bun HTTP server — routes requests, owns the Storage instance lifetime.
 *
 * Routes:
 *   GET  /health       — liveness + db stats (open on public ingress)
 *   POST /index        — index a doc (internal-only)
 *   POST /search       — hybrid retrieve { q, k? }
 *   POST /backlinks    — entity-mention reverse lookup
 *   POST /friction     — log "agent confused" event (internal-only)
 *   GET  /friction     — analyse friction events
 *   POST /mcp          — MCP JSON-RPC 2.0 (tools `index` + `log_friction`
 *                        rejected from public; rest open with bearer)
 *
 * Public requests are detected via the `Cf-Connecting-Ip` header set by
 * cloudflared. Bearer auth is required for any non-`/health` public
 * request — see `http/public_guard.ts`.
 */
import type { Storage } from "../core/storage.ts";
import { handleHealth } from "./health.ts";
import { handleIndex } from "./index_route.ts";
import { handleSearch } from "./search_route.ts";
import { handleBacklinks } from "./backlinks_route.ts";
import {
  handleFrictionGet,
  handleFrictionPost,
} from "./friction_route.ts";
import {
  handlePagePut,
  handlePageAppend,
  handlePageDelete,
  handlePageGet,
  handlePageList,
  handlePageVersions,
} from "./pages_route.ts";
import {
  evaluatePublicGuard,
  evaluateInternalAuth,
  isPublicMcpToolForbidden,
} from "./public_guard.ts";
import { makeMcpHandler } from "../mcp/http_transport.ts";
import { RateLimiter } from "../mcp/rate_limit.ts";

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
   * the `MEMEX_PUBLIC_BEARER` env / `openclaw/memex-public-bearer`
   * secret. When unset, internal requests still flow but every public
   * request returns 503 — fail-closed.
   */
  publicBearerToken?: string;
  /**
   * Shared secret required on internal mutating routes (POST /index,
   * POST /friction, MCP write tools). Defends the docker-bridge
   * surface from a compromised sibling container. Wire from
   * `MEMEX_INTERNAL_TOKEN` env / `<secrets_prefix>/memex-internal-token`.
   * When unset, internal routes stay open (legacy single-node behaviour)
   * — a single startup warning is logged; operators should configure
   * the secret.
   */
  internalToken?: string;
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
  const internalAuthOpts: { internalToken?: string } = {};
  if (opts.internalToken) {
    internalAuthOpts.internalToken = opts.internalToken;
  } else {
    console.warn(
      "[memex] WARNING: MEMEX_INTERNAL_TOKEN not configured — internal " +
        "mutating routes (POST /index, POST /friction) are open to any " +
        "peer on the docker bridge. Configure the token via " +
        "<secrets_prefix>/memex-internal-token + fetch-secrets.sh.",
    );
  }

  const server = Bun.serve({
    hostname: opts.host,
    port: opts.port,
    fetch: async (req) => {
      const url = new URL(req.url);

      const guard = evaluatePublicGuard(req, url, guardOpts);
      if (!guard.allow) {
        return Response.json(
          { ok: false, error: guard.reason },
          { status: guard.status },
        );
      }

      if (url.pathname === "/health" && req.method === "GET") {
        return handleHealth(opts.storage);
      }
      if (url.pathname === "/index" && req.method === "POST") {
        if (guard.isPublic) {
          return Response.json(
            { ok: false, error: "/index is internal-only" },
            { status: 403 },
          );
        }
        // Internal mutating route — require the shared internal token
        // so a compromised sibling container on the docker bridge
        // cannot blindly poison the index.
        const ia = evaluateInternalAuth(req, internalAuthOpts);
        if (!ia.allow) {
          return Response.json(
            { ok: false, error: ia.reason },
            { status: ia.status },
          );
        }
        return handleIndex(opts.storage, req);
      }
      if (url.pathname === "/search" && req.method === "POST") {
        return handleSearch(opts.storage, req, guard.isPublic);
      }
      if (url.pathname === "/backlinks" && req.method === "POST") {
        return handleBacklinks(opts.storage, req, guard.isPublic);
      }
      if (url.pathname === "/friction" && req.method === "POST") {
        if (guard.isPublic) {
          return Response.json(
            { ok: false, error: "/friction is internal-only" },
            { status: 403 },
          );
        }
        const ia = evaluateInternalAuth(req, internalAuthOpts);
        if (!ia.allow) {
          return Response.json(
            { ok: false, error: ia.reason },
            { status: ia.status },
          );
        }
        return handleFrictionPost(opts.storage, req);
      }
      if (url.pathname === "/friction" && req.method === "GET") {
        return handleFrictionGet(opts.storage);
      }
      // ---------------------------------------------------------------
      // Pages (DB-canonical store) — writes are internal-only and gated
      // by the shared internal token; reads return redacted shapes on
      // public ingress unless MEMEX_PUBLIC_READ_BODIES=1.
      // ---------------------------------------------------------------
      if (url.pathname === "/pages/put" && req.method === "POST") {
        if (guard.isPublic) {
          return Response.json(
            { ok: false, error: "/pages/put is internal-only" },
            { status: 403 },
          );
        }
        const ia = evaluateInternalAuth(req, internalAuthOpts);
        if (!ia.allow) {
          return Response.json(
            { ok: false, error: ia.reason },
            { status: ia.status },
          );
        }
        return handlePagePut(opts.storage, req, guard.isPublic);
      }
      if (url.pathname === "/pages/append" && req.method === "POST") {
        if (guard.isPublic) {
          return Response.json(
            { ok: false, error: "/pages/append is internal-only" },
            { status: 403 },
          );
        }
        const ia = evaluateInternalAuth(req, internalAuthOpts);
        if (!ia.allow) {
          return Response.json(
            { ok: false, error: ia.reason },
            { status: ia.status },
          );
        }
        return handlePageAppend(opts.storage, req, guard.isPublic);
      }
      if (url.pathname === "/pages/delete" && req.method === "POST") {
        if (guard.isPublic) {
          return Response.json(
            { ok: false, error: "/pages/delete is internal-only" },
            { status: 403 },
          );
        }
        const ia = evaluateInternalAuth(req, internalAuthOpts);
        if (!ia.allow) {
          return Response.json(
            { ok: false, error: ia.reason },
            { status: ia.status },
          );
        }
        return handlePageDelete(opts.storage, req, guard.isPublic);
      }
      if (url.pathname === "/pages/get" && req.method === "GET") {
        return handlePageGet(opts.storage, url, guard.isPublic);
      }
      if (url.pathname === "/pages/list" && req.method === "POST") {
        return handlePageList(opts.storage, req, guard.isPublic);
      }
      if (url.pathname === "/pages/versions" && req.method === "GET") {
        return handlePageVersions(opts.storage, url, guard.isPublic);
      }
      if (url.pathname === "/mcp" && mcpHandler) {
        return mcpHandler(req, { isPublic: guard.isPublic });
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
