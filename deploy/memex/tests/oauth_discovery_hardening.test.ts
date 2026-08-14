/**
 * OAuth discovery hardening: the RFC 9728 protected-resource metadata
 * document + the WWW-Authenticate challenge on /mcp 401, plus default-deny
 * CORS on the OAuth/MCP surface.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { startServer, type ServerHandle } from "../src/http/server.ts";
import {
  buildProtectedResourceMetadata,
  wwwAuthenticateChallenge,
  OAUTH_PROTECTED_RESOURCE_PATH,
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
  process.env.MEMEX_HTTP_CORS_ORIGIN = "https://allowed.example";
  tmp = mkdtempSync(join(tmpdir(), "memex-disc-"));
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
  delete process.env.MEMEX_HTTP_CORS_ORIGIN;
  await server.stop();
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("protected-resource metadata (RFC 9728)", () => {
  it("builds resource == authorization server == issuer", () => {
    const doc = buildProtectedResourceMetadata("https://brain.example");
    expect(doc.resource).toBe("https://brain.example");
    expect(doc.authorization_servers).toEqual(["https://brain.example"]);
    expect(doc.bearer_methods_supported).toEqual(["header"]);
    expect(doc.scopes_supported.length).toBeGreaterThan(0);
  });

  it("serves the document publicly (no bearer required)", async () => {
    const res = await fetch(`${url}${OAUTH_PROTECTED_RESOURCE_PATH}`, {
      headers: { "Cf-Connecting-Ip": "1.2.3.4" },
    });
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { resource: string; authorization_servers: string[] };
    expect(doc.authorization_servers.length).toBe(1);
    expect(doc.resource).toBe(doc.authorization_servers[0]!);
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
    const challenge = res.headers.get("WWW-Authenticate");
    expect(challenge).toContain("Bearer");
    expect(challenge).toContain(OAUTH_PROTECTED_RESOURCE_PATH);
  });

  it("wwwAuthenticateChallenge points at the issuer's metadata path", () => {
    const v = wwwAuthenticateChallenge("https://brain.example");
    expect(v).toBe(
      'Bearer error="invalid_token", resource_metadata="https://brain.example/.well-known/oauth-protected-resource"',
    );
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
