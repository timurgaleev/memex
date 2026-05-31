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
      if (url.pathname === "/mcp" && mcpHandler) {
        // Evaluate the internal-token gate once per request; the handler
        // enforces it only for write tools on the internal path (read
        // tools and public traffic ignore it). `allow` is true when the
        // token is unconfigured (legacy fallthrough) or correctly sent.
        const ia = evaluateInternalAuth(req, internalAuthOpts);
        return mcpHandler(req, {
          isPublic: guard.isPublic,
          internalAuthOk: ia.allow,
        });
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
