/**
 * MCP request-log DB sink (opt-in MEMEX_REQUEST_LOG_DB, force-on for OAuth
 * ingress). Inserts one redacted row per tool call into mcp_request_log;
 * no-op when disabled and not forced; fire-and-forget. Fail-visible: the
 * transport logs rejections (rate-limit, public-forbidden, internal-token,
 * scope) + tools/list with error_message/token_name populated.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { logToolCallToDb, requestLogDbEnabled } from "../src/core/../mcp/request-log-db.ts";
import { makeMcpHandler } from "../src/mcp/http_transport.ts";
import { RateLimiter } from "../src/mcp/rate_limit.ts";
import type { AuthInfo } from "../src/core/auth-info.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-reqlogdb-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});
afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
  delete process.env["MEMEX_REQUEST_LOG_DB"];
});

async function rowCount(): Promise<number> {
  const r = await storage.engine().query<{ n: number }>("SELECT count(*)::int AS n FROM mcp_request_log");
  return r.rows[0]?.n ?? 0;
}

describe("logToolCallToDb", () => {
  it("is a no-op when the flag is off", async () => {
    expect(requestLogDbEnabled()).toBe(false);
    logToolCallToDb(storage.engine(), { tool: "search", agentName: "public", latencyMs: 5, ok: true, params: { q: "x" } });
    await new Promise((r) => setTimeout(r, 30));
    expect(await rowCount()).toBe(0);
  });

  it("inserts a redacted row when enabled (known tool, summary params)", async () => {
    process.env["MEMEX_REQUEST_LOG_DB"] = "1";
    logToolCallToDb(storage.engine(), { tool: "search", agentName: "client-1", latencyMs: 12, ok: true, params: { q: "secret query" } });
    await new Promise((r) => setTimeout(r, 50)); // let the detached insert land
    const r = await storage.engine().query<{ operation: string; agent_name: string; status: string; latency_ms: number; params: unknown }>(
      "SELECT operation, agent_name, status, latency_ms, params FROM mcp_request_log LIMIT 1",
    );
    const row = r.rows[0]!;
    expect(row.operation).toBe("search");
    expect(row.agent_name).toBe("client-1");
    expect(row.status).toBe("success");
    expect(row.latency_ms).toBe(12);
    // Redacted: the raw "secret query" must NOT appear in the stored summary.
    expect(JSON.stringify(row.params)).not.toContain("secret query");
  });

  it("stores an unknown tool name as 'unknown' (no raw caller input)", async () => {
    process.env["MEMEX_REQUEST_LOG_DB"] = "1";
    logToolCallToDb(storage.engine(), { tool: "../etc/passwd", agentName: "x", latencyMs: 1, ok: false, params: {} });
    await new Promise((r) => setTimeout(r, 50));
    const r = await storage.engine().query<{ operation: string; status: string }>("SELECT operation, status FROM mcp_request_log LIMIT 1");
    expect(r.rows[0]?.operation).toBe("unknown");
    expect(r.rows[0]?.status).toBe("error");
  });

  it("writes token_name + error_message, and force overrides the OFF flag", async () => {
    expect(requestLogDbEnabled()).toBe(false);
    logToolCallToDb(storage.engine(), {
      tool: "search",
      agentName: "client-2",
      tokenName: "client-2",
      latencyMs: 3,
      ok: false,
      params: null,
      errorMessage: "insufficient_scope: requires 'write'",
      force: true,
    });
    await new Promise((r) => setTimeout(r, 50));
    const r = await storage.engine().query<{ token_name: string; error_message: string }>(
      "SELECT token_name, error_message FROM mcp_request_log LIMIT 1",
    );
    expect(r.rows[0]?.token_name).toBe("client-2");
    expect(r.rows[0]?.error_message).toContain("insufficient_scope");
  });
});

describe("transport fail-visible logging (OAuth path, flag OFF)", () => {
  const oauthCtx = (over: Partial<AuthInfo> = {}) => ({
    isPublic: false,
    authInfo: {
      token: "t",
      clientId: "oauth-client",
      scopes: ["read"],
      isPublic: false,
      ...over,
    } as AuthInfo,
  });

  function rpc(body: unknown): Request {
    return new Request("http://test/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function rows(): Promise<Array<{ operation: string; status: string; token_name: string | null; error_message: string | null }>> {
    const r = await storage.engine().query<{ operation: string; status: string; token_name: string | null; error_message: string | null }>(
      "SELECT operation, status, token_name, error_message FROM mcp_request_log ORDER BY id",
    );
    return r.rows;
  }

  it("logs tools/list for OAuth callers without the env flag", async () => {
    const handler = makeMcpHandler({ storage });
    const res = await handler(rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }), oauthCtx());
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    const all = await rows();
    expect(all.length).toBe(1);
    expect(all[0]?.operation).toBe("tools/list");
    expect(all[0]?.token_name).toBe("oauth-client");
    expect(all[0]?.status).toBe("success");
  });

  it("logs a scope rejection with error_message", async () => {
    const handler = makeMcpHandler({ storage });
    await handler(
      rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "page_put", arguments: { slug: "a" } } }),
      oauthCtx(), // read-only scopes → insufficient_scope
    );
    await new Promise((r) => setTimeout(r, 50));
    const all = await rows();
    const row = all.find((r) => r.operation === "page_put");
    expect(row?.status).toBe("error");
    expect(row?.error_message ?? "").toContain("scope");
  });

  it("logs a public-forbidden rejection", async () => {
    const handler = makeMcpHandler({ storage, forbidPublicTool: (n) => n === "index" });
    await handler(
      rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "index", arguments: {} } }),
      { ...oauthCtx({ isPublic: true }), isPublic: true },
    );
    await new Promise((r) => setTimeout(r, 50));
    const row = (await rows()).find((r) => r.operation === "index");
    expect(row?.status).toBe("error");
    expect(row?.error_message ?? "").toContain("forbidden_public");
  });

  it("logs an internal-token rejection", async () => {
    const handler = makeMcpHandler({ storage, forbidPublicTool: (n) => n === "index" });
    await handler(
      rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "index", arguments: {} } }),
      { ...oauthCtx(), internalAuthOk: false },
    );
    await new Promise((r) => setTimeout(r, 50));
    const row = (await rows()).find((r) => r.operation === "index");
    expect(row?.status).toBe("error");
    expect(row?.error_message ?? "").toContain("internal token");
  });

  it("rate-limit rejections are best-effort: NOT force-written while the sink is off", async () => {
    // Deliberate: a hammering client must not convert every 429
    // into a guaranteed DB INSERT — the limiter must keep shedding DB load.
    const handler = makeMcpHandler({
      storage,
      publicRateLimiter: new RateLimiter({ capacity: 1, refillPerSecond: 0.001 }),
    });
    const publicCtx = { ...oauthCtx({ isPublic: true }), isPublic: true };
    await handler(rpc({ jsonrpc: "2.0", id: 5, method: "ping" }), publicCtx);
    const res = await handler(rpc({ jsonrpc: "2.0", id: 6, method: "ping" }), publicCtx);
    expect(res.status).toBe(429);
    await new Promise((r) => setTimeout(r, 50));
    expect((await rows()).find((r) => r.operation === "rate_limited")).toBeUndefined();
  });

  it("rate-limit rejections land in the log when the sink is enabled", async () => {
    process.env["MEMEX_REQUEST_LOG_DB"] = "1";
    try {
      const handler = makeMcpHandler({
        storage,
        publicRateLimiter: new RateLimiter({ capacity: 1, refillPerSecond: 0.001 }),
      });
      const publicCtx = { ...oauthCtx({ isPublic: true }), isPublic: true };
      await handler(rpc({ jsonrpc: "2.0", id: 5, method: "ping" }), publicCtx);
      const res = await handler(rpc({ jsonrpc: "2.0", id: 6, method: "ping" }), publicCtx);
      expect(res.status).toBe(429);
      await new Promise((r) => setTimeout(r, 50));
      const row = (await rows()).find((r) => r.operation === "rate_limited");
      expect(row?.status).toBe("error");
      expect(row?.token_name).toBe("oauth-client");
    } finally {
      delete process.env["MEMEX_REQUEST_LOG_DB"];
    }
  });

  it("does NOT log unauthenticated traffic while the flag is off", async () => {
    const handler = makeMcpHandler({ storage });
    await handler(rpc({ jsonrpc: "2.0", id: 7, method: "tools/list" }), { isPublic: false });
    await new Promise((r) => setTimeout(r, 50));
    expect((await rows()).length).toBe(0);
  });
});
