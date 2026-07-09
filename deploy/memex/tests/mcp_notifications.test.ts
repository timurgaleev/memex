/**
 * MCP post-initialize notification handling. The standard MCP handshake sends a
 * `notifications/initialized` JSON-RPC notification (no `id`) after `initialize`.
 * A notification expects no response body — the transport acknowledges it with an
 * empty HTTP 204 (reference parity), NOT a -32601 method-not-found error.
 */
import { describe, expect, test } from "bun:test";
import { makeMcpHandler } from "../src/mcp/http_transport.ts";
import { RateLimiter } from "../src/mcp/rate_limit.ts";

const handler = makeMcpHandler({
  storage: { engine: () => ({ query: async () => ({ rows: [] }) }) } as never,
  publicRateLimiter: new RateLimiter({ capacity: 100, refillPerSecond: 100 }),
  internalRateLimiter: new RateLimiter({ capacity: 100, refillPerSecond: 100 }),
  perTokenRateLimiter: new RateLimiter({ capacity: 100, refillPerSecond: 100 }),
  clientKey: () => "ip-0",
});

const post = (body: unknown, ctx: Record<string, unknown> = { isPublic: false }) =>
  handler(
    new Request("http://x/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    ctx as never,
  );

describe("MCP notifications/initialized", () => {
  test("acknowledged with an empty 204, no body", async () => {
    const res = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  test("an unknown method still returns the -32601 envelope at 200", async () => {
    const res = await post({ jsonrpc: "2.0", id: 1, method: "does/not/exist" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { error?: { code?: number } };
    expect(body.error?.code).toBe(-32601);
  });
});
