/**
 * OAuth discovery: RFC 8414 authorization-server metadata (right shape, and
 * reachable without a bearer even from the public Cloudflare ingress), the
 * RFC 9728 protected-resource metadata document + the WWW-Authenticate
 * challenge on /mcp 401, plus default-deny CORS on the OAuth/MCP surface.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { startServer, type ServerHandle } from "../src/http/server.ts";
import {
  buildOAuthMetadata,
  resolveIssuer,
  OAUTH_METADATA_PATH,
  buildProtectedResourceMetadata,
  canonicalResource,
  wwwAuthenticateChallenge,
  OAUTH_PROTECTED_RESOURCE_PATH,
  OAUTH_PROTECTED_RESOURCE_MCP_PATH,
} from "../src/http/oauth-metadata.ts";
import {
  parseCorsAllowlist,
  corsPreflightResponse,
  applyCorsHeaders,
} from "../src/http/cors.ts";

let tmp: string;
let storage: Storage;
let server: ServerHandle;
let url: string;

beforeAll(async () => {
  process.env.MEMRAIN_HTTP_CORS_ORIGIN = "https://allowed.example";
  tmp = mkdtempSync(join(tmpdir(), "memrain-disc-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  server = startServer({
    host: "127.0.0.1",
    port: 0,
    storage,
    publicBearerToken: "static-bearer-secret",
  });
  url = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  delete process.env.MEMRAIN_HTTP_CORS_ORIGIN;
  await server.stop();
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

afterEach(() => {
  delete process.env.MEMRAIN_PUBLIC_URL;
});

describe("buildOAuthMetadata — full standard surface", () => {
  it("advertises issuer + endpoints; registration_endpoint only when DCR is enabled", () => {
    const m = buildOAuthMetadata("https://brain.example") as unknown as Record<string, unknown>;
    expect(m.issuer).toBe("https://brain.example");
    expect(m.authorization_endpoint).toBe("https://brain.example/authorize");
    expect(m.token_endpoint).toBe("https://brain.example/token");
    expect(m.revocation_endpoint).toBe("https://brain.example/revoke");
    // Only what a connector can obtain; operator-only scopes are not offered.
    expect(m.scopes_supported).toEqual(["read", "write"]);
    // DCR is OFF by default → the self-registration endpoint is NOT advertised.
    expect(m.registration_endpoint).toBeUndefined();
    // When DCR is enabled, it appears.
    const withDcr = buildOAuthMetadata("https://brain.example", true) as unknown as Record<string, unknown>;
    expect(withDcr.registration_endpoint).toBe("https://brain.example/register");
  });

  it("advertises the auth-code + refresh + client_credentials grants and S256 PKCE", () => {
    const m = buildOAuthMetadata("https://brain.example") as unknown as Record<string, unknown>;
    expect(m.response_types_supported).toEqual(["code"]);
    expect(m.grant_types_supported).toEqual([
      "authorization_code",
      "refresh_token",
      "client_credentials",
    ]);
    expect(m.token_endpoint_auth_methods_supported).toEqual([
      "client_secret_post",
      "client_secret_basic",
      "none",
    ]);
    expect(m.code_challenge_methods_supported).toEqual(["S256"]);
  });

  it("advertises the RFC 9207 iss parameter on authorization responses", () => {
    expect(buildOAuthMetadata("https://brain.example").authorization_response_iss_parameter_supported).toBe(true);
  });
});

describe("resolveIssuer — base URL resolution", () => {
  it("prefers the explicit publicUrl and strips a trailing slash", () => {
    const u = new URL("http://internal-host:18790/.well-known/x");
    expect(resolveIssuer(u, "https://brain.example/")).toBe(
      "https://brain.example",
    );
  });

  it("falls back to MEMRAIN_PUBLIC_URL env when no opt is passed", () => {
    process.env.MEMRAIN_PUBLIC_URL = "https://env.example";
    const u = new URL("http://internal-host:18790/.well-known/x");
    expect(resolveIssuer(u)).toBe("https://env.example");
  });

  it("falls back to the request origin when nothing is declared", () => {
    const u = new URL("http://127.0.0.1:8080/.well-known/x");
    expect(resolveIssuer(u)).toBe("http://127.0.0.1:8080");
  });
});

describe("GET /.well-known/oauth-authorization-server — live route", () => {
  it("is reachable from the public ingress WITHOUT a bearer", async () => {
    const res = await fetch(`${url}${OAUTH_METADATA_PATH}`, {
      // Simulate the Cloudflare public ingress; no Authorization header.
      headers: { "Cf-Connecting-Ip": "1.2.3.4" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.issuer).toBe(url);
    expect(body.token_endpoint).toBe(`${url}/token`);
    expect(body.authorization_endpoint).toBe(`${url}/authorize`);
    expect(body.scopes_supported).toEqual(["read", "write"]);
    expect(body.grant_types_supported).toEqual([
      "authorization_code",
      "refresh_token",
      "client_credentials",
    ]);
  });

  it("advertises the configured public issuer over the request host", async () => {
    // A separate server instance carrying an explicit public URL.
    process.env.MEMRAIN_PUBLIC_URL = "https://brain.public.example";
    const res = await fetch(`${url}${OAUTH_METADATA_PATH}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.issuer).toBe("https://brain.public.example");
    expect(body.token_endpoint).toBe("https://brain.public.example/token");
    // A DECLARED issuer is safe to cache publicly.
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
  });

  it("does NOT public-cache a host-derived issuer (cache-poisoning guard)", async () => {
    // No MEMRAIN_PUBLIC_URL → issuer falls back to the request Host, which a shared
    // cache could poison — so the response must be no-store.
    const res = await fetch(`${url}${OAUTH_METADATA_PATH}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("protected-resource metadata (RFC 9728)", () => {
  it("builds resource = the /mcp endpoint, authorization server = issuer", () => {
    const doc = buildProtectedResourceMetadata("https://brain.example");
    expect(doc.resource).toBe("https://brain.example/mcp");
    expect(doc.authorization_servers).toEqual(["https://brain.example"]);
    expect(doc.bearer_methods_supported).toEqual(["header"]);
    expect(doc.scopes_supported).toEqual(["read", "write"]);
  });

  it("serves the /mcp path form publicly with resource = issuer/mcp", async () => {
    expect(OAUTH_PROTECTED_RESOURCE_MCP_PATH).toBe("/.well-known/oauth-protected-resource/mcp");
    const res = await fetch(`${url}${OAUTH_PROTECTED_RESOURCE_MCP_PATH}`, {
      headers: { "Cf-Connecting-Ip": "1.2.3.4" },
    });
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { resource: string; authorization_servers: string[] };
    expect(doc.authorization_servers).toEqual([url]);
    expect(doc.resource).toBe(`${url}/mcp`);
  });

  it("keeps the bare path answering with the same document", async () => {
    const [bare, path] = await Promise.all(
      [OAUTH_PROTECTED_RESOURCE_PATH, OAUTH_PROTECTED_RESOURCE_MCP_PATH].map(async (p) => {
        const res = await fetch(`${url}${p}`, { headers: { "Cf-Connecting-Ip": "1.2.3.4" } });
        expect(res.status).toBe(200);
        return res.json();
      }),
    );
    expect(bare).toEqual(path);
  });

  it("answers an unpublished /.well-known document with a 404, not a 401", async () => {
    for (const p of [
      "/.well-known/openid-configuration",
      "/.well-known/oauth-authorization-server/mcp",
    ]) {
      const res = await fetch(`${url}${p}`, { headers: { "Cf-Connecting-Ip": "1.2.3.4" } });
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(res.headers.get("WWW-Authenticate")).toBeNull();
    }
  });

  it("challenges a request with no credential without an error code, naming the scopes", async () => {
    const res = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: { "Cf-Connecting-Ip": "1.2.3.4", "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe(
      `Bearer resource_metadata="${url}${OAUTH_PROTECTED_RESOURCE_MCP_PATH}", scope="read write"`,
    );
  });

  it("challenges a 401 on /mcp with resource_metadata (WWW-Authenticate)", async () => {
    const res = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: {
        "Cf-Connecting-Ip": "1.2.3.4",
        "Content-Type": "application/json",
        Authorization: "Bearer wrong-token",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe(
      `Bearer error="invalid_token", resource_metadata="${url}${OAUTH_PROTECTED_RESOURCE_MCP_PATH}"`,
    );
  });

  it("wwwAuthenticateChallenge points at the /mcp metadata path", () => {
    expect(wwwAuthenticateChallenge("https://brain.example")).toBe(
      'Bearer error="invalid_token", resource_metadata="https://brain.example/.well-known/oauth-protected-resource/mcp"',
    );
    expect(wwwAuthenticateChallenge("https://brain.example", false)).toBe(
      'Bearer resource_metadata="https://brain.example/.well-known/oauth-protected-resource/mcp", scope="read write"',
    );
  });
});

describe("canonicalResource (RFC 8707)", () => {
  const issuer = "https://brain.example";
  it("folds both spellings of this server, with or without a slash, onto /mcp", () => {
    for (const v of [
      "https://brain.example",
      "https://brain.example/",
      "https://BRAIN.example:443/",
      "https://brain.example/mcp",
      "https://brain.example/mcp/",
    ]) {
      expect(canonicalResource(v, issuer)).toBe("https://brain.example/mcp");
    }
  });

  it("refuses any other resource", () => {
    for (const v of [
      "https://evil.example/mcp",
      "http://brain.example/mcp",
      "https://brain.example/mcp/other",
      "https://brain.example/admin",
      "https://brain.example/mcp?x=1",
      "https://brain.example/mcp#frag",
      "not a url",
    ]) {
      expect(canonicalResource(v, issuer)).toBeNull();
    }
  });
});

describe("CORS on the OAuth/MCP surface (default deny)", () => {
  it("preflight grants an allowlisted origin", async () => {
    const res = await fetch(`${url}/token`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://allowed.example",
        "Access-Control-Request-Method": "POST",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://allowed.example");
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
  });

  it("preflight denies a non-allowlisted origin (no grant headers)", async () => {
    const res = await fetch(`${url}/mcp`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://evil.example",
        "Access-Control-Request-Method": "POST",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("stamps allow-origin on actual /mcp responses for allowlisted origins", async () => {
    const res = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: {
        Origin: "https://allowed.example",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://allowed.example");
  });

  it("parseCorsAllowlist: unset/empty → null (deny all)", () => {
    // NOTE: passing `undefined` would fall back to the env default (set in
    // beforeAll for the server-level cases), so only literals are asserted.
    expect(parseCorsAllowlist("")).toBeNull();
    expect(parseCorsAllowlist(" , ")).toBeNull();
    expect(parseCorsAllowlist("https://a.example, https://b.example")).toEqual(
      new Set(["https://a.example", "https://b.example"]),
    );
  });

  it("helpers: deny-by-default without an allowlist", () => {
    const req = new Request("http://test/mcp", {
      method: "OPTIONS",
      headers: { Origin: "https://anywhere.example" },
    });
    const pre = corsPreflightResponse(req, null);
    expect(pre.status).toBe(204);
    expect(pre.headers.get("Access-Control-Allow-Origin")).toBeNull();
    const res = applyCorsHeaders(Response.json({}), req, null);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});
