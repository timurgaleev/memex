/**
 * Pre-auth throttle on the token-verification path, and per-client keying of
 * the OAuth endpoint limiters.
 *
 * `OAuthProvider.verifyAccessToken` runs DB SELECTs and is reached only AFTER
 * the public guard rejected the request — `guard.allow` is false there, so the
 * /mcp handler (and its rate limiter) never runs. An unauthenticated caller
 * spraying junk bearers therefore drove unbounded DB load. The throttle sheds
 * that BEFORE the lookup and meters FAILURES only, so a legitimate client
 * keeps its budget. EVERY request class is metered: trusted client IP, then
 * the socket address, then one shared bucket with a wider — but real —
 * ceiling.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import {
  startServer,
  resolveRateLimitBucket,
  attemptLimiterFor,
  ATTRIBUTED_AUTH_ATTEMPT_LIMITS,
  UNATTRIBUTED_AUTH_ATTEMPT_LIMITS,
  UNATTRIBUTED_RATE_KEY,
  type ServerHandle,
} from "../src/http/server.ts";
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

  it("meters a caller with no trusted client IP, via its socket address", async () => {
    // REWRITTEN. This used to assert "never throttles a caller it cannot
    // attribute", on the rationale that one shared bucket lets a sprayer lock
    // everyone out. The effect was the opposite of a defence: the caller that
    // presents no forwarding header — the one a brute-forcer actually is — got
    // an unmetered channel, two DB round-trips per attempt, forever. A caller
    // without Cf-Connecting-Ip still has a socket address, which separates the
    // bridge peers from each other just as well, so meter on that.
    process.env["MEMEX_ASSUME_PUBLIC"] = "1";
    const { provider, calls } = stubProvider("good-token");
    const url = await boot(
      provider,
      new RateLimiter({ capacity: 1, refillPerSecond: 0 }),
    );

    expect((await post(url, "junk-0")).status).toBe(401); // spends the token
    const throttled = await post(url, "junk-1");
    expect(throttled.status).toBe(429);
    expect(Number(throttled.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
    expect(calls()).toBe(1); // the second attempt never reached the DB
  });
});

describe("pre-auth attempt keying", () => {
  it("prefers the trusted client IP", () => {
    expect(resolveRateLimitBucket("9.9.9.9", "172.18.0.4")).toEqual({
      key: "9.9.9.9",
      unattributed: false,
    });
  });

  it("falls back to the socket address, which still names one peer", () => {
    expect(resolveRateLimitBucket(null, "172.18.0.4")).toEqual({
      key: "172.18.0.4",
      unattributed: false,
    });
  });

  it("falls back to ONE shared bucket when nothing resolves", () => {
    for (const socket of [undefined, null, ""]) {
      expect(resolveRateLimitBucket(null, socket)).toEqual({
        key: UNATTRIBUTED_RATE_KEY,
        unattributed: true,
      });
    }
  });

  it("charges the shared bucket against its own limiter", () => {
    const attributed = new RateLimiter({ capacity: 1, refillPerSecond: 0 });
    const unattributed = new RateLimiter({ capacity: 1, refillPerSecond: 0 });
    expect(
      attemptLimiterFor({ unattributed: true }, attributed, unattributed),
    ).toBe(unattributed);
    expect(
      attemptLimiterFor({ unattributed: false }, attributed, unattributed),
    ).toBe(attributed);
  });

  it("the shared bucket is wider than a per-caller one — and still has a ceiling", () => {
    const shared = UNATTRIBUTED_AUTH_ATTEMPT_LIMITS.capacity ?? 0;
    const perCaller = ATTRIBUTED_AUTH_ATTEMPT_LIMITS.capacity ?? 0;
    expect(shared).toBeGreaterThan(perCaller);
    expect(Number.isFinite(shared)).toBe(true);

    // Burn the real default capacity: attempt `shared + 1` must be shed, or an
    // unattributable sprayer is back to being unmetered.
    const limiter = new RateLimiter(UNATTRIBUTED_AUTH_ATTEMPT_LIMITS);
    const at = 1_000; // fixed clock: no refill mid-run
    for (let i = 0; i < shared; i++) {
      expect(limiter.allow(UNATTRIBUTED_RATE_KEY, at)).toBe(true);
    }
    expect(limiter.allow(UNATTRIBUTED_RATE_KEY, at)).toBe(false);
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
