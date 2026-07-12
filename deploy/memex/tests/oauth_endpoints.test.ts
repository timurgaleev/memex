/**
 * OAuth 2.1 authorization-code + PKCE / DCR / revoke over the live HTTP ingress.
 *
 * Exercises the routes wired in http/oauth-endpoints.ts + server.ts against a
 * real PGLite-backed Storage (no external services). Covers the standard
 * MCP-client flow end to end: /authorize → code → /token with a PKCE verifier,
 * plus the negative paths (verifier mismatch, code replay, redirect_uri
 * allowlist), Dynamic Client Registration, and revocation.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { Storage } from "../src/core/storage.ts";
import { startServer, type ServerHandle } from "../src/http/server.ts";
import { OAuthProvider } from "../src/core/oauth-provider.ts";

const PUB_TOKEN = "pub-bearer-oauth-endpoints";
const REDIRECT = "https://client.example/cb";
const ADMIN_TOKEN = "admin-bootstrap-oauth-test";

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

describe("OAuth 2.1 authorization-code + PKCE / DCR / revoke", () => {
  let tmp: string;
  let storage: Storage;
  let provider: OAuthProvider;
  let server: ServerHandle;
  let url: string;
  // Public PKCE client (token_endpoint_auth_method='none').
  let pubClientId: string;
  // Confidential client_credentials client.
  let confClientId: string;
  let confClientSecret: string;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "memex-oauth-ep-"));
    storage = new Storage({ dbPath: join(tmp, "db") });
    await storage.init();
    provider = new OAuthProvider({ engine: storage.raw() });

    const pub = await provider.registerClientManual(
      "pkce-client",
      ["authorization_code", "refresh_token"],
      "read",
      [REDIRECT],
      "default",
      undefined,
      "none",
    );
    pubClientId = pub.clientId;

    const conf = await provider.registerClientManual(
      "cc-client",
      ["client_credentials"],
      "read",
      [],
      "default",
    );
    confClientId = conf.clientId;
    confClientSecret = conf.clientSecret!;

    server = startServer({
      host: "127.0.0.1",
      port: 0,
      storage,
      publicBearerToken: PUB_TOKEN,
      oauthProvider: provider,
      adminBootstrapToken: ADMIN_TOKEN,
    });
    url = `http://127.0.0.1:${server.port}`;

    // /authorize is gated on a logged-in operator (the resource owner). Establish
    // an admin session once and reuse its cookie for the authorize happy paths.
    const login = await fetch(`${url}/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: ADMIN_TOKEN }),
    });
    const setCookie = login.headers.get("set-cookie") ?? "";
    adminCookie = setCookie.split(";")[0] ?? ""; // name=value only
  });

  let adminCookie = "";

  afterEach(async () => {
    await server.stop();
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  /** GET /authorize as the logged-in operator (carries the admin session cookie). */
  async function authorize(params: Record<string, string>): Promise<Response> {
    const q = new URLSearchParams(params);
    return fetch(`${url}/authorize?${q}`, {
      redirect: "manual",
      headers: adminCookie ? { Cookie: adminCookie } : {},
    });
  }

  async function tokenForm(body: Record<string, string>): Promise<Response> {
    return fetch(`${url}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body),
    });
  }

  // DCR is OFF by default; spin a DCR-enabled server for the tests that exercise
  // /register, then tear it down + clear the env. DCR only boots when /authorize
  // enforces operator consent, so pair MEMEX_ENABLE_DCR with
  // MEMEX_OAUTH_REQUIRE_LOGIN + an admin token (the secure production posture).
  async function withDcr<T>(fn: (base: string) => Promise<T>): Promise<T> {
    process.env.MEMEX_ENABLE_DCR = "1";
    process.env.MEMEX_OAUTH_REQUIRE_LOGIN = "1";
    const s = startServer({
      host: "127.0.0.1",
      port: 0,
      storage,
      oauthProvider: provider,
      adminBootstrapToken: ADMIN_TOKEN,
    });
    try {
      return await fn(`http://127.0.0.1:${s.port}`);
    } finally {
      await s.stop();
      delete process.env.MEMEX_ENABLE_DCR;
      delete process.env.MEMEX_OAUTH_REQUIRE_LOGIN;
    }
  }

  it("PKCE happy path: authorize → code → token with the right verifier", async () => {
    const { verifier, challenge } = pkce();
    const authRes = await authorize({
      response_type: "code",
      client_id: pubClientId,
      redirect_uri: REDIRECT,
      scope: "read",
      state: "xyz",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    expect(authRes.status).toBe(302);
    const loc = new URL(authRes.headers.get("location")!);
    expect(loc.searchParams.get("state")).toBe("xyz");
    const code = loc.searchParams.get("code")!;
    expect(code).toMatch(/^memex_code_/);

    const tokRes = await tokenForm({
      grant_type: "authorization_code",
      client_id: pubClientId,
      code,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
    });
    expect(tokRes.status).toBe(200);
    const body = (await tokRes.json()) as {
      access_token: string;
      refresh_token?: string;
      token_type: string;
    };
    expect(body.token_type).toBe("bearer");
    expect(body.access_token).toMatch(/^memex_at_/);
    expect(body.refresh_token).toMatch(/^memex_rt_/);

    // The minted token resolves to the public client + its source scope.
    const info = await provider.verifyAccessToken(body.access_token);
    expect(info.clientId).toBe(pubClientId);
    expect(info.scopes).toContain("read");
  });

  it("opt-in: with MEMEX_OAUTH_REQUIRE_LOGIN=1, /authorize without a session issues NO code (302 → login)", async () => {
    process.env.MEMEX_OAUTH_REQUIRE_LOGIN = "1";
    const gsrv = startServer({
      host: "127.0.0.1",
      port: 0,
      storage,
      oauthProvider: provider,
      adminBootstrapToken: ADMIN_TOKEN,
    });
    try {
      const { challenge } = pkce();
      const q = new URLSearchParams({
        response_type: "code",
        client_id: pubClientId,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: "S256",
      });
      // Gate ON + no admin cookie → bounce to login, no code minted.
      const res = await fetch(`http://127.0.0.1:${gsrv.port}/authorize?${q}`, {
        redirect: "manual",
      });
      expect(res.status).toBe(302);
      const loc = res.headers.get("location") ?? "";
      expect(loc.startsWith("/admin/login")).toBe(true);
      expect(loc).not.toContain("code=");
    } finally {
      await gsrv.stop();
      delete process.env.MEMEX_OAUTH_REQUIRE_LOGIN;
    }
  });

  it("SECURITY: DCR is disabled by default → /register returns 404 (no self-registration)", async () => {
    const res = await fetch(`${url}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "stranger",
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: "none",
        scope: "read write",
      }),
    });
    expect(res.status).toBe(404);
  });

  it("SECURITY: when DCR is enabled it clamps an elevated scope request to read/write", async () => {
    process.env.MEMEX_ENABLE_DCR = "1";
    process.env.MEMEX_OAUTH_REQUIRE_LOGIN = "1";
    const gsrv = startServer({
      host: "127.0.0.1",
      port: 0,
      storage,
      oauthProvider: provider,
      adminBootstrapToken: ADMIN_TOKEN,
    });
    try {
      // A real client copies the whole advertised scope list into its DCR
      // request. We CLAMP (not reject): registration succeeds, elevated dropped.
      const res = await fetch(`http://127.0.0.1:${gsrv.port}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "claude-like",
          redirect_uris: [REDIRECT],
          token_endpoint_auth_method: "none",
          scope: "admin agent read sources_admin users_admin write",
        }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { client_id: string; scope?: string };
      const granted = (body.scope ?? "").split(/\s+/).filter(Boolean).sort();
      expect(granted).toEqual(["read", "write"]);
      expect(body.scope ?? "").not.toContain("admin");
    } finally {
      await gsrv.stop();
      delete process.env.MEMEX_ENABLE_DCR;
      delete process.env.MEMEX_OAUTH_REQUIRE_LOGIN;
    }
  });

  it("PKCE mismatch is rejected AND does not consume the code", async () => {
    const { challenge } = pkce();
    const authRes = await authorize({
      response_type: "code",
      client_id: pubClientId,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    const code = new URL(authRes.headers.get("location")!).searchParams.get(
      "code",
    )!;

    // Wrong verifier → invalid_grant, code NOT burned.
    const bad = await tokenForm({
      grant_type: "authorization_code",
      client_id: pubClientId,
      code,
      redirect_uri: REDIRECT,
      code_verifier: "not-the-real-verifier",
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe(
      "invalid_grant",
    );

    // The genuine verifier still works because the failed attempt didn't
    // consume the code — but we minted the challenge freshly here, so redo with
    // a matching pair to prove the "not consumed" property.
    const p = pkce();
    const a2 = await authorize({
      response_type: "code",
      client_id: pubClientId,
      redirect_uri: REDIRECT,
      code_challenge: p.challenge,
      code_challenge_method: "S256",
    });
    const code2 = new URL(a2.headers.get("location")!).searchParams.get(
      "code",
    )!;
    await tokenForm({
      grant_type: "authorization_code",
      client_id: pubClientId,
      code: code2,
      redirect_uri: REDIRECT,
      code_verifier: "wrong-again",
    });
    const good = await tokenForm({
      grant_type: "authorization_code",
      client_id: pubClientId,
      code: code2,
      redirect_uri: REDIRECT,
      code_verifier: p.verifier,
    });
    expect(good.status).toBe(200);
  });

  it("authorization code is single-use", async () => {
    const { verifier, challenge } = pkce();
    const authRes = await authorize({
      response_type: "code",
      client_id: pubClientId,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    const code = new URL(authRes.headers.get("location")!).searchParams.get(
      "code",
    )!;
    const first = await tokenForm({
      grant_type: "authorization_code",
      client_id: pubClientId,
      code,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
    });
    expect(first.status).toBe(200);
    const second = await tokenForm({
      grant_type: "authorization_code",
      client_id: pubClientId,
      code,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
    });
    expect(second.status).toBe(400);
    expect(((await second.json()) as { error: string }).error).toBe(
      "invalid_grant",
    );
  });

  it("redirect_uri allowlist is enforced (unregistered → 400, no redirect)", async () => {
    const { challenge } = pkce();
    const res = await authorize({
      response_type: "code",
      client_id: pubClientId,
      redirect_uri: "https://evil.example/steal",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    // Must NOT redirect to the attacker URI — a direct 400 instead.
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });

  it("DCR (when enabled) mints a public client and a confidential client", async () => {
    await withDcr(async (base) => {
      // Public (PKCE) client — no secret in the response.
      const pubRes = await fetch(`${base}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "dcr-public",
          redirect_uris: [REDIRECT],
          grant_types: ["authorization_code"],
          token_endpoint_auth_method: "none",
          scope: "read",
        }),
      });
      expect(pubRes.status).toBe(201);
      const pubBody = (await pubRes.json()) as {
        client_id: string;
        client_secret?: string;
      };
      expect(pubBody.client_id).toMatch(/^memex_cl_/);
      expect(pubBody.client_secret).toBeUndefined();

      // Confidential client — secret returned exactly once. A self-registered
      // client is held to the consent-bearing authorization_code grant.
      const confRes = await fetch(`${base}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "dcr-conf",
          redirect_uris: [REDIRECT],
          grant_types: ["authorization_code"],
          scope: "read",
        }),
      });
      expect(confRes.status).toBe(201);
      const confBody = (await confRes.json()) as { client_secret?: string };
      expect(confBody.client_secret).toMatch(/^memex_cs_/);
    });
  });

  it("SECURITY: DCR refuses a client_credentials registration (consent bypass)", async () => {
    await withDcr(async (base) => {
      const res = await fetch(`${base}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "m2m-wannabe",
          redirect_uris: [REDIRECT],
          grant_types: ["client_credentials"],
          scope: "read",
        }),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe(
        "invalid_client_metadata",
      );
    });
  });

  it("DCR defaults an omitted grant_types to authorization_code", async () => {
    await withDcr(async (base) => {
      const res = await fetch(`${base}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "dcr-default-grant",
          redirect_uris: [REDIRECT],
          token_endpoint_auth_method: "none",
          scope: "read",
        }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        client_id: string;
        grant_types: string[];
      };
      expect(body.grant_types).toEqual(["authorization_code"]);
      const stored = await provider.getClient(body.client_id);
      expect(stored?.grant_types).toEqual(["authorization_code"]);
    });
  });

  it("SECURITY: insecure DCR mode permits a client_credentials registration", async () => {
    // MEMEX_ENABLE_DCR_INSECURE=1 both opts the provider into the
    // machine-to-machine path and satisfies the DCR consent boot check without
    // MEMEX_OAUTH_REQUIRE_LOGIN. Mirror that env with an insecure provider.
    const insecureProvider = new OAuthProvider({
      engine: storage.raw(),
      allowClientCredentialsDcr: true,
    });
    process.env.MEMEX_ENABLE_DCR_INSECURE = "1";
    const s = startServer({
      host: "127.0.0.1",
      port: 0,
      storage,
      oauthProvider: insecureProvider,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${s.port}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "m2m-allowed",
          redirect_uris: [REDIRECT],
          grant_types: ["client_credentials"],
          scope: "read",
        }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        client_secret?: string;
        grant_types: string[];
      };
      expect(body.grant_types).toEqual(["client_credentials"]);
      expect(body.client_secret).toMatch(/^memex_cs_/);
    } finally {
      await s.stop();
      delete process.env.MEMEX_ENABLE_DCR_INSECURE;
    }
  });

  it("registerClient (unit) allows client_credentials when opted in", async () => {
    const insecureProvider = new OAuthProvider({
      engine: storage.raw(),
      allowClientCredentialsDcr: true,
    });
    const client = await insecureProvider.registerClient({
      client_name: "unit-m2m",
      grant_types: ["client_credentials"],
      scope: "read",
    });
    expect(client.grant_types).toEqual(["client_credentials"]);
    expect(client.client_secret).toMatch(/^memex_cs_/);
  });

  it("SECURITY: refuses to boot with DCR on while /authorize auto-approves", async () => {
    process.env.MEMEX_ENABLE_DCR = "1";
    try {
      expect(() =>
        startServer({
          host: "127.0.0.1",
          port: 0,
          storage,
          oauthProvider: provider,
          adminBootstrapToken: ADMIN_TOKEN,
        }),
      ).toThrow(/auto-approve/i);
    } finally {
      delete process.env.MEMEX_ENABLE_DCR;
    }
  });

  it("boots with DCR on when MEMEX_OAUTH_REQUIRE_LOGIN gates /authorize", async () => {
    process.env.MEMEX_ENABLE_DCR = "1";
    process.env.MEMEX_OAUTH_REQUIRE_LOGIN = "1";
    let s: ServerHandle | undefined;
    try {
      s = startServer({
        host: "127.0.0.1",
        port: 0,
        storage,
        oauthProvider: provider,
        adminBootstrapToken: ADMIN_TOKEN,
      });
      expect(s.port).toBeGreaterThan(0);
    } finally {
      if (s) await s.stop();
      delete process.env.MEMEX_ENABLE_DCR;
      delete process.env.MEMEX_OAUTH_REQUIRE_LOGIN;
    }
  });

  it("boots with DCR on when MEMEX_ENABLE_DCR_INSECURE acknowledges the risk", async () => {
    process.env.MEMEX_ENABLE_DCR_INSECURE = "1";
    let s: ServerHandle | undefined;
    try {
      s = startServer({
        host: "127.0.0.1",
        port: 0,
        storage,
        oauthProvider: provider,
      });
      expect(s.port).toBeGreaterThan(0);
    } finally {
      if (s) await s.stop();
      delete process.env.MEMEX_ENABLE_DCR_INSECURE;
    }
  });

  it("DCR (when enabled) rejects a non-loopback http:// redirect_uri", async () => {
    await withDcr(async (base) => {
      const res = await fetch(`${base}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "bad-redirect",
          redirect_uris: ["http://evil.example/cb"],
        }),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe(
        "invalid_redirect_uri",
      );
    });
  });

  it("revoke invalidates an access token", async () => {
    // Mint a client_credentials access token for the confidential client.
    const tok = (await (
      await tokenForm({
        grant_type: "client_credentials",
        client_id: confClientId,
        client_secret: confClientSecret,
      })
    ).json()) as { access_token: string };
    // Token verifies before revocation.
    const before = await provider.verifyAccessToken(tok.access_token);
    expect(before.clientId).toBe(confClientId);

    // Revoke it (client-authenticated).
    const revRes = await fetch(`${url}/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: tok.access_token,
        client_id: confClientId,
        client_secret: confClientSecret,
      }),
    });
    expect(revRes.status).toBe(200);

    // After revocation the token no longer verifies.
    await expect(
      provider.verifyAccessToken(tok.access_token),
    ).rejects.toThrow();
  });

  it("revoke requires client authentication", async () => {
    const tok = (await (
      await tokenForm({
        grant_type: "client_credentials",
        client_id: confClientId,
        client_secret: confClientSecret,
      })
    ).json()) as { access_token: string };
    // Wrong secret → 401 invalid_client, token stays valid.
    const res = await fetch(`${url}/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: tok.access_token,
        client_id: confClientId,
        client_secret: "memex_cs_wrong",
      }),
    });
    expect(res.status).toBe(401);
    const still = await provider.verifyAccessToken(tok.access_token);
    expect(still.clientId).toBe(confClientId);
  });

  it("/authorize is reachable from the public ingress without a bearer and auto-approves (default)", async () => {
    const { challenge } = pkce();
    const q = new URLSearchParams({
      response_type: "code",
      client_id: pubClientId,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    // Public ingress, no bearer: the route is exempt from the public guard and,
    // by default (no MEMEX_OAUTH_REQUIRE_LOGIN), auto-approves — issuing a code
    // back to the registered redirect_uri.
    const res = await fetch(`${url}/authorize?${q}`, {
      redirect: "manual",
      headers: { "Cf-Connecting-Ip": "9.9.9.9" },
    });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe(REDIRECT);
    expect(loc.searchParams.get("code")).toMatch(/^memex_code_/);
  });
});
