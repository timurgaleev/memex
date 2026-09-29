/**
 * Client-key resolution shared by every header-keyed ingress rate limiter.
 *
 * `Cf-Connecting-Ip` is trusted unconditionally (the Cloudflare edge and the
 * Caddy ingress both inject it). `X-Forwarded-For` / `X-Real-IP` are honoured
 * ONLY under MEMEX_HTTP_TRUST_PROXY=1: otherwise they are caller-spoofable, and
 * a spoofable key is worse than a coarse one — the caller just rotates values
 * to mint a fresh bucket per request.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { resolveClientIp, resolveClientKey } from "../src/http/client-key.ts";
import { RateLimiter } from "../src/mcp/rate_limit.ts";
import { makeMcpHandler } from "../src/mcp/http_transport.ts";

const ORIGINAL = process.env["MEMEX_HTTP_TRUST_PROXY"];
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env["MEMEX_HTTP_TRUST_PROXY"];
  else process.env["MEMEX_HTTP_TRUST_PROXY"] = ORIGINAL;
});

const req = (headers: Record<string, string>) =>
  new Request("http://x/mcp", { method: "POST", headers });

describe("resolveClientIp / resolveClientKey", () => {
  test("proxy headers are ignored by default — the caller is unattributable", () => {
    delete process.env["MEMEX_HTTP_TRUST_PROXY"];
    expect(resolveClientIp(req({ "X-Forwarded-For": "1.1.1.1" }))).toBeNull();
    expect(resolveClientIp(req({ "X-Real-IP": "1.1.1.1" }))).toBeNull();
    expect(resolveClientIp(req({}))).toBeNull();
    expect(resolveClientKey(req({ "X-Forwarded-For": "1.1.1.1" }))).toBe("internal");
  });

  test("with MEMEX_HTTP_TRUST_PROXY=1 the FIRST XFF hop identifies the caller", () => {
    process.env["MEMEX_HTTP_TRUST_PROXY"] = "1";
    expect(
      resolveClientIp(req({ "X-Forwarded-For": "1.1.1.1, 10.0.0.5, 10.0.0.6" })),
    ).toBe("1.1.1.1");
    expect(resolveClientIp(req({ "X-Real-IP": "2.2.2.2" }))).toBe("2.2.2.2");
    expect(resolveClientKey(req({ "X-Real-IP": "2.2.2.2" }))).toBe("2.2.2.2");
  });

  test("Cf-Connecting-Ip wins over the proxy headers, flag or no flag", () => {
    process.env["MEMEX_HTTP_TRUST_PROXY"] = "1";
    expect(
      resolveClientIp(
        req({ "Cf-Connecting-Ip": "3.3.3.3", "X-Forwarded-For": "1.1.1.1" }),
      ),
    ).toBe("3.3.3.3");
    delete process.env["MEMEX_HTTP_TRUST_PROXY"];
    expect(
      resolveClientIp(
        req({ "Cf-Connecting-Ip": "3.3.3.3", "X-Forwarded-For": "1.1.1.1" }),
      ),
    ).toBe("3.3.3.3");
  });

  test("an empty header value is not an identity", () => {
    process.env["MEMEX_HTTP_TRUST_PROXY"] = "1";
    expect(resolveClientIp(req({ "Cf-Connecting-Ip": "  " }))).toBeNull();
    expect(resolveClientIp(req({ "X-Forwarded-For": " , 1.1.1.1" }))).toBeNull();
  });
});

describe("MCP transport per-IP buckets", () => {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
  const mk = (xff: string) =>
    new Request("http://x/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Forwarded-For": xff },
      body,
    });
  const handler = () =>
    makeMcpHandler({
      storage: {
        engine: () => ({ query: async () => ({ rows: [] }) }),
      } as never,
      publicRateLimiter: new RateLimiter({ capacity: 1, refillPerSecond: 0 }),
    });

  test("distinct XFF callers get distinct buckets under the flag", async () => {
    process.env["MEMEX_HTTP_TRUST_PROXY"] = "1";
    const h = handler();
    expect((await h(mk("1.1.1.1"), { isPublic: true })).status).toBe(200);
    expect((await h(mk("2.2.2.2"), { isPublic: true })).status).toBe(200);
  });

  test("without the flag they share the one unattributable bucket", async () => {
    delete process.env["MEMEX_HTTP_TRUST_PROXY"];
    const h = handler();
    expect((await h(mk("1.1.1.1"), { isPublic: true })).status).toBe(200);
    expect((await h(mk("2.2.2.2"), { isPublic: true })).status).toBe(429);
  });
});
