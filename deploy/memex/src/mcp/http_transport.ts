/**
 * MCP HTTP transport — POST /mcp accepting JSON-RPC 2.0 requests.
 *
 * Supported methods:
 *   - `initialize`               handshake, returns server capabilities
 *   - `tools/list`               returns TOOL_DEFS
 *   - `tools/call`               { name, arguments } → tool result
 *   - `ping`                     health probe (returns {})
 *
 * Anything else returns -32601 (method not found). Malformed JSON gets
 * -32700 (parse error). Spec: https://www.jsonrpc.org/specification
 *
 * MCP spec for HTTP transport allows either a single JSON-RPC object or
 * an array (batched). We handle both.
 */
import type { Storage } from "../core/storage.ts";
import { TOOL_DEFS } from "./tool_defs.ts";
import { dispatchTool } from "./dispatch.ts";
import { RateLimiter } from "./rate_limit.ts";
import { parseJsonBody } from "../http/body_limit.ts";

const PROTOCOL_VERSION = "2025-03-26";
const SERVER_INFO = { name: "memex", version: "0.1.0" };

export interface McpHandlerOptions {
  storage: Storage;
  rateLimiter?: RateLimiter;
  /** Override the IP key extraction (e.g. for tests). */
  clientKey?: (req: Request) => string;
  /** Predicate for tools that must NOT be callable from public requests
   *  (mutating ones — `index`, `log_friction`). The server route layer
   *  passes per-request `isPublic` and we cross-reference. */
  forbidPublicTool?: (toolName: string) => boolean;
}

/** Per-request context the server passes to handleMcp. */
export interface McpRequestContext {
  isPublic: boolean;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const ERR_PARSE = -32700;
const ERR_INVALID_REQUEST = -32600;
const ERR_METHOD_NOT_FOUND = -32601;
const ERR_INTERNAL = -32603;
const ERR_RATE_LIMITED = -32000; // server-defined band

function defaultClientKey(req: Request): string {
  // Trust hierarchy:
  //   1. `Cf-Connecting-Ip` — set by the Cloudflare edge for traffic
  //      that came through the tunnel. This is the only header we
  //      actually trust to identify a remote caller. CF strips
  //      attacker-supplied copies of this header.
  //   2. For requests NOT carrying Cf-Connecting-Ip (internal Docker
  //      bridge traffic from openclaw → memex), key everyone into a
  //      single "internal" bucket. X-Forwarded-For / X-Real-IP are
  //      attacker-controlled when the request is NOT proxied through
  //      a trust boundary, so using them as a rate-limit key lets a
  //      caller rotate values freely and defeat per-IP limits.
  const cfIp = req.headers.get("Cf-Connecting-Ip");
  if (cfIp) {
    const trimmed = cfIp.trim();
    if (trimmed.length > 0) return trimmed;
  }
  // Non-public path — single bucket. The internal caller IS trusted
  // (it's the openclaw container) but should still be rate-limited as
  // one entity rather than per-spoofed-XFF.
  return "internal";
}

export function makeMcpHandler(opts: McpHandlerOptions) {
  const limiter = opts.rateLimiter ?? new RateLimiter();
  const keyFn = opts.clientKey ?? defaultClientKey;
  const forbidPublic = opts.forbidPublicTool ?? (() => false);

  return async function handleMcp(
    req: Request,
    ctx: McpRequestContext = { isPublic: false },
  ): Promise<Response> {
    if (req.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }
    if (!limiter.allow(keyFn(req))) {
      return Response.json(
        rpcError(null, ERR_RATE_LIMITED, "rate limit exceeded"),
        { status: 429 },
      );
    }

    const parsedBody = await parseJsonBody<unknown>(req);
    if (!parsedBody.ok) {
      // parseJsonBody returns 400 / 413; rewrap as JSON-RPC parse error
      // so the MCP client sees the standard envelope.
      const status = parsedBody.response.status;
      return Response.json(
        rpcError(null, ERR_PARSE, status === 413 ? "body too large" : "parse error"),
        { status },
      );
    }
    const raw: unknown = parsedBody.body;

    if (Array.isArray(raw)) {
      const responses = await Promise.all(
        raw.map((r) =>
          handleSingle(opts.storage, r as JsonRpcRequest, ctx, forbidPublic),
        ),
      );
      return Response.json(responses);
    }
    const single = await handleSingle(
      opts.storage,
      raw as JsonRpcRequest,
      ctx,
      forbidPublic,
    );
    return Response.json(single);
  };
}

async function handleSingle(
  storage: Storage,
  req: JsonRpcRequest,
  ctx: McpRequestContext,
  forbidPublic: (name: string) => boolean,
): Promise<JsonRpcResponse> {
  const id = req?.id ?? null;
  if (!req || req.jsonrpc !== "2.0" || typeof req.method !== "string") {
    return rpcError(id, ERR_INVALID_REQUEST, "invalid JSON-RPC request");
  }

  switch (req.method) {
    case "initialize":
      return rpcOk(id, {
        protocolVersion: PROTOCOL_VERSION,
        serverInfo: SERVER_INFO,
        capabilities: { tools: {} },
      });
    case "tools/list":
      // For public requests we filter the tool list so an external
      // client can't even DISCOVER the mutating tools.
      if (ctx.isPublic) {
        return rpcOk(id, {
          tools: TOOL_DEFS.filter((t) => !forbidPublic(t.name)),
        });
      }
      return rpcOk(id, { tools: TOOL_DEFS });
    case "tools/call": {
      const params = (req.params ?? {}) as {
        name?: string;
        arguments?: Record<string, unknown>;
      };
      if (typeof params.name !== "string") {
        return rpcError(id, ERR_INVALID_REQUEST, "tools/call: `name` required");
      }
      if (ctx.isPublic && forbidPublic(params.name)) {
        return rpcError(
          id,
          ERR_INVALID_REQUEST,
          `tool ${params.name} is not callable from the public ingress`,
        );
      }
      try {
        const result = await dispatchTool(storage, {
          name: params.name,
          arguments: params.arguments,
        });
        return rpcOk(id, result);
      } catch (e) {
        return rpcError(
          id,
          ERR_INTERNAL,
          e instanceof Error ? e.message : String(e),
        );
      }
    }
    case "ping":
      return rpcOk(id, {});
    default:
      return rpcError(id, ERR_METHOD_NOT_FOUND, `method not found: ${req.method}`);
  }
}

function rpcOk(
  id: string | number | null,
  result: unknown,
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  const err: JsonRpcResponse["error"] = { code, message };
  if (data !== undefined) err.data = data;
  return { jsonrpc: "2.0", id, error: err };
}
