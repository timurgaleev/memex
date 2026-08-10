/**
 * Pre-auth throttle on the token-verification path, and per-client keying of
 * the OAuth endpoint limiters.
 *
 * `OAuthProvider.verifyAccessToken` runs DB SELECTs and is reached only AFTER
 * the public guard rejected the request — `guard.allow` is false there, so the
 * /mcp handler (and its rate limiter) never runs. An unauthenticated caller
 * spraying junk bearers therefore drove unbounded DB load. The throttle sheds
 * that BEFORE the lookup, meters FAILURES only, and refuses to throttle a
 * caller it cannot attribute (no trusted client IP → one shared bucket would
 * let one sprayer lock out everybody else).
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { startServer, type ServerHandle } from "../src/http/server.ts";
import {
  InvalidTokenError,
  OAuthProvider,
} from "../src/core/oauth-provider.ts";
import { RateLimiter } from "../src/mcp/rate_limit.ts";

const PUB = "pub-bearer-preauth";
const PING = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });

describe("pre-auth token-verification throttle", () => {
  let tmp = "";
  let storage: Storage | undefined;
  let server: ServerHandle | undefined;
  const savedAssumePublic = process.env["MEMEX_ASSUME_PUBLIC"];

  afterEach(async () => {
    await server?.stop();
    await storage?.close();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = "";
    server = undefined;
    storage = undefined;
    if (savedAssumePublic === undefined) delete process.env["MEMEX_ASSUME_PUBLIC"];
    else process.env["MEMEX_ASSUME_PUBLIC"] = savedAssumePublic;
  });

  async function boot(
    provider: OAuthProvider,
    limiter: RateLimiter,
  ): Promise<string> {
    tmp = mkdtempSync(join(tmpdir(), "memex-preauth-"));
    storage = new Storage({ dbPath: join(tmp, "db") });
    await storage.init();
    server = startServer({
      host: "127.0.0.1",
      port: 0,
      storage,
      publicBearerToken: PUB,
      oauthProvider: provider,
      authAttemptRateLimiter: limiter,
    });
    return `http://127.0.0.1:${server.port}`;
  }

  /** A provider stub that counts verifications — the DB-query proxy. */
  function stubProvider(valid: string): { provider: OAuthProvider; calls: () => number } {
    let calls = 0;
    const provider = {
      verifyAccessToken: async (token: string) => {
        calls++;
        if (token !== valid) throw new InvalidTokenError("Invalid token");
        return {
          token,
          clientId: "client-1",
          scopes: ["read"],
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
        };
      },
    } as unknown as OAuthProvider;
    return { provider, calls: () => calls };
  }

  const post = (url: string, bearer: string, ip?: string) =>
    fetch(`${url}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearer}`,
        ...(ip ? { "Cf-Connecting-Ip": ip } : {}),
      },
      body: PING,
    });

  it("429s a junk bearer BEFORE the DB lookup once the bucket is empty", async () => {
    const { provider, calls } = stubProvider("good-token");
    const url = await boot(
      provider,
      new RateLimiter({ capacity: 1, refillPerSecond: 0 }),
    );

    const first = await post(url, "junk-1", "9.9.9.1");
    expect(first.status).toBe(401);
    expect(calls()).toBe(1);

    const second = await post(url, "junk-2", "9.9.9.1");
    expect(second.status).toBe(429);
    expect(Number(second.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
    expect(calls()).toBe(1); // no second DB query — that is the whole point

    // A different client IP keeps its own bucket.
    const other = await post(url, "junk-3", "9.9.9.2");
    expect(other.status).toBe(401);
    expect(calls()).toBe(2);
  });

  it("meters FAILED verifications only, so a valid token never spends a token", async () => {
    const { provider, calls } = stubProvider("good-token");
    const url = await boot(
      provider,
      new RateLimiter({ capacity: 2, refillPerSecond: 0 }),
    );

    expect((await post(url, "junk-1", "9.9.9.4")).status).toBe(401); // 1 left
    expect((await post(url, "good-token", "9.9.9.4")).status).toBe(200); // free
    expect((await post(url, "junk-2", "9.9.9.4")).status).toBe(401); // 0 left
    expect((await post(url, "junk-3", "9.9.9.4")).status).toBe(429);
    expect(calls()).toBe(3);
  });

  it("never throttles a caller it cannot attribute (no shared-bucket lockout)", async () => {
    // MEMEX_ASSUME_PUBLIC makes every request public even without a trusted
    // client IP. With one shared bucket, a single sprayer would 429 every other
    // caller on that ingress — so unattributable callers are not metered at all.
    process.env["MEMEX_ASSUME_PUBLIC"] = "1";
    const { provider, calls } = stubProvider("good-token");
    const url = await boot(
      provider,
      new RateLimiter({ capacity: 1, refillPerSecond: 0 }),
    );

    for (let i = 0; i < 3; i++) {
      expect((await post(url, `junk-${i}`)).status).toBe(401);
    }
    expect(calls()).toBe(3);
    expect((await post(url, "good-token")).status).toBe(200);
  });
});

describe("OAuth endpoint limiters are keyed per client, not per socket", () => {
  let tmp = "";
  let storage: Storage | undefined;
  let server: ServerHandle | undefined;

  afterEach(async () => {
    await server?.stop();
    await storage?.close();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = "";
    server = undefined;
    storage = undefined;
  });

  it("one client exhausting /token does not lock out a different client IP", async () => {
    tmp = mkdtempSync(join(tmpdir(), "memex-tokenkey-"));
    storage = new Storage({ dbPath: join(tmp, "db") });
    await storage.init();
    const provider = new OAuthProvider({ engine: storage.raw() });
    server = startServer({
      host: "127.0.0.1",
      port: 0,
      storage,
      publicBearerToken: PUB,
      oauthProvider: provider,
    });
    const url = `http://127.0.0.1:${server.port}`;
    const token = (ip: string) =>
      fetch(`${url}/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Cf-Connecting-Ip": ip,
        },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: "memex_cl_nope",
          client_secret: "memex_cs_nope",
        }),
      });

    // The limiter holds 10 tokens; the 11th attempt from that IP is shed.
    for (let i = 0; i < 10; i++) {
      expect((await token("8.8.8.1")).status).not.toBe(429);
    }
    expect((await token("8.8.8.1")).status).toBe(429);

    // A different caller must still be served.
    expect((await token("8.8.8.2")).status).not.toBe(429);
  });
});
