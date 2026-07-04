/**
 * OAuth discovery tests — `GET /.well-known/oauth-authorization-server` must
 * return RFC 8414 metadata with the right shape AND be reachable without a
 * bearer, even from the public Cloudflare ingress. Uses a fresh PGLite-backed
 * Storage so no external services are touched.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { startServer, type ServerHandle } from "../src/http/server.ts";
import {
  buildOAuthMetadata,
  resolveIssuer,
  OAUTH_METADATA_PATH,
} from "../src/http/oauth-metadata.ts";
import { ALLOWED_SCOPES_LIST } from "../src/core/scope.ts";

const TOKEN = "test-bearer-abc123";

let tmp: string;
let storage: Storage;
let server: ServerHandle;
let base: string;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-oauthmeta-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  // Bearer configured — proves the discovery route is exempt from it.
  server = startServer({
    host: "127.0.0.1",
    port: 0,
    storage,
    publicBearerToken: TOKEN,
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterEach(async () => {
  await server.stop();
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.MEMEX_PUBLIC_URL;
});

describe("buildOAuthMetadata — shape (honest: only wired endpoints)", () => {
  it("advertises the issuer + token endpoint + client_credentials only", () => {
    const m = buildOAuthMetadata("https://brain.example") as unknown as Record<string, unknown>;
    expect(m.issuer).toBe("https://brain.example");
    expect(m.token_endpoint).toBe("https://brain.example/token");
    expect(m.scopes_supported).toEqual([...ALLOWED_SCOPES_LIST]);
    expect(m.grant_types_supported).toEqual(["client_credentials"]);
    expect(m.token_endpoint_auth_methods_supported).toEqual(["client_secret_post"]);
  });

  it("does NOT advertise unimplemented auth-code/DCR/revoke endpoints", () => {
    const m = buildOAuthMetadata("https://brain.example") as unknown as Record<string, unknown>;
    // These 404 today — advertising them would break a strict auth-code client.
    expect(m.authorization_endpoint).toBeUndefined();
    expect(m.registration_endpoint).toBeUndefined();
    expect(m.revocation_endpoint).toBeUndefined();
    expect(m.response_types_supported).toBeUndefined();
    expect(m.code_challenge_methods_supported).toBeUndefined();
  });
});

describe("resolveIssuer — base URL resolution", () => {
  it("prefers the explicit publicUrl and strips a trailing slash", () => {
    const u = new URL("http://internal-host:18790/.well-known/x");
    expect(resolveIssuer(u, "https://brain.example/")).toBe(
      "https://brain.example",
    );
  });

  it("falls back to MEMEX_PUBLIC_URL env when no opt is passed", () => {
    process.env.MEMEX_PUBLIC_URL = "https://env.example";
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
    const res = await fetch(`${base}${OAUTH_METADATA_PATH}`, {
      // Simulate the Cloudflare public ingress; no Authorization header.
      headers: { "Cf-Connecting-Ip": "1.2.3.4" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.issuer).toBe(base);
    expect(body.token_endpoint).toBe(`${base}/token`);
    expect(body.scopes_supported).toEqual([...ALLOWED_SCOPES_LIST]);
    expect(body.grant_types_supported).toEqual(["client_credentials"]);
  });

  it("advertises the configured public issuer over the request host", async () => {
    // A separate server instance carrying an explicit public URL.
    process.env.MEMEX_PUBLIC_URL = "https://brain.public.example";
    const res = await fetch(`${base}${OAUTH_METADATA_PATH}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.issuer).toBe("https://brain.public.example");
    expect(body.token_endpoint).toBe("https://brain.public.example/token");
    // A DECLARED issuer is safe to cache publicly.
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
  });

  it("does NOT public-cache a host-derived issuer (cache-poisoning guard)", async () => {
    // No MEMEX_PUBLIC_URL → issuer falls back to the request Host, which a shared
    // cache could poison — so the response must be no-store.
    const res = await fetch(`${base}${OAUTH_METADATA_PATH}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});
