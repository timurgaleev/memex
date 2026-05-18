/**
 * Public-guard tests — exercise the bearer + write-protect logic
 * against the http server end-to-end. Uses a fresh PGLite-backed
 * Storage so we hit no external services.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { startServer, type ServerHandle } from "../src/http/server.ts";
import {
  evaluatePublicGuard,
  isPublicMcpToolForbidden,
} from "../src/http/public_guard.ts";

let tmp: string;
let storage: Storage;
let server: ServerHandle;
let url: string;

const TOKEN = "test-bearer-abc123";

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-pubguard-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  server = startServer({
    host: "127.0.0.1",
    port: 0,
    storage,
    publicBearerToken: TOKEN,
  });
  url = `http://127.0.0.1:${server.port}`;
});

afterEach(async () => {
  await server.stop();
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("evaluatePublicGuard — pure logic", () => {
  function urlOf(path: string): URL {
    return new URL(`http://x${path}`);
  }
  function publicReq(path: string, method = "POST", auth?: string): Request {
    const headers: Record<string, string> = { "Cf-Connecting-Ip": "1.2.3.4" };
    if (auth) headers["Authorization"] = auth;
    return new Request(`http://x${path}`, { method, headers });
  }

  it("internal request is always allowed", () => {
    const r = evaluatePublicGuard(
      new Request("http://x/index", { method: "POST" }),
      urlOf("/index"),
      { bearerToken: TOKEN },
    );
    expect(r.allow).toBe(true);
    if (r.allow) expect(r.isPublic).toBe(false);
  });

  it("public /health GET is open without auth", () => {
    const r = evaluatePublicGuard(
      publicReq("/health", "GET"),
      urlOf("/health"),
      { bearerToken: TOKEN },
    );
    expect(r.allow).toBe(true);
    if (r.allow) expect(r.isPublic).toBe(true);
  });

  it("public /index POST is rejected even with bearer", () => {
    const r = evaluatePublicGuard(
      publicReq("/index", "POST", `Bearer ${TOKEN}`),
      urlOf("/index"),
      { bearerToken: TOKEN },
    );
    expect(r.allow).toBe(false);
    if (!r.allow) expect(r.status).toBe(403);
  });

  it("public /friction POST is rejected", () => {
    const r = evaluatePublicGuard(
      publicReq("/friction", "POST", `Bearer ${TOKEN}`),
      urlOf("/friction"),
      { bearerToken: TOKEN },
    );
    expect(r.allow).toBe(false);
    if (!r.allow) expect(r.status).toBe(403);
  });

  it("public /search POST without bearer → 401", () => {
    const r = evaluatePublicGuard(
      publicReq("/search"),
      urlOf("/search"),
      { bearerToken: TOKEN },
    );
    expect(r.allow).toBe(false);
    if (!r.allow) expect(r.status).toBe(401);
  });

  it("public /search POST with wrong bearer → 401", () => {
    const r = evaluatePublicGuard(
      publicReq("/search", "POST", "Bearer wrong"),
      urlOf("/search"),
      { bearerToken: TOKEN },
    );
    expect(r.allow).toBe(false);
    if (!r.allow) expect(r.status).toBe(401);
  });

  it("public /search POST with correct bearer → allow", () => {
    const r = evaluatePublicGuard(
      publicReq("/search", "POST", `Bearer ${TOKEN}`),
      urlOf("/search"),
      { bearerToken: TOKEN },
    );
    expect(r.allow).toBe(true);
    if (r.allow) expect(r.isPublic).toBe(true);
  });

  it("public + token unset → 503 (fail-closed)", () => {
    const r = evaluatePublicGuard(
      publicReq("/search", "POST", `Bearer whatever`),
      urlOf("/search"),
      {},
    );
    expect(r.allow).toBe(false);
    if (!r.allow) expect(r.status).toBe(503);
  });
});

describe("isPublicMcpToolForbidden", () => {
  it("blocks `index` and `log_friction`", () => {
    expect(isPublicMcpToolForbidden("index")).toBe(true);
    expect(isPublicMcpToolForbidden("log_friction")).toBe(true);
  });

  it("blocks every page write tool (page_put, page_append, page_delete)", () => {
    expect(isPublicMcpToolForbidden("page_put")).toBe(true);
    expect(isPublicMcpToolForbidden("page_append")).toBe(true);
    expect(isPublicMcpToolForbidden("page_delete")).toBe(true);
  });

  it("allows `search`, `backlinks`, `stats`", () => {
    expect(isPublicMcpToolForbidden("search")).toBe(false);
    expect(isPublicMcpToolForbidden("backlinks")).toBe(false);
    expect(isPublicMcpToolForbidden("stats")).toBe(false);
  });

  it("allows page reads (page_get, page_list, page_versions)", () => {
    expect(isPublicMcpToolForbidden("page_get")).toBe(false);
    expect(isPublicMcpToolForbidden("page_list")).toBe(false);
    expect(isPublicMcpToolForbidden("page_versions")).toBe(false);
  });
});

describe("HTTP server end-to-end with public guard", () => {
  it("/health open without bearer for public requests", async () => {
    const r = await fetch(`${url}/health`, {
      headers: { "Cf-Connecting-Ip": "1.2.3.4" },
    });
    expect(r.status).toBe(200);
  });

  it("public /search rejects missing bearer", async () => {
    const r = await fetch(`${url}/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Cf-Connecting-Ip": "1.2.3.4",
      },
      body: JSON.stringify({ q: "x" }),
    });
    expect(r.status).toBe(401);
  });

  it("public /index rejected even with valid bearer", async () => {
    const r = await fetch(`${url}/index`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Cf-Connecting-Ip": "1.2.3.4",
        "Authorization": `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ sourcePath: "x.md", text: "hi" }),
    });
    expect(r.status).toBe(403);
  });

  it("internal /index works (no Cf-Connecting-Ip header)", async () => {
    // Real index would call Bedrock — we stop at routing-level success
    // by sending malformed body and checking we got past the guard
    // (i.e. not 401/403 — got the route's own validation error).
    const r = await fetch(`${url}/index`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ /* missing both shapes */ }),
    });
    // Route-level validation rejects; guard would return 401/403.
    expect([400, 500].includes(r.status)).toBe(true);
  });

  it("public MCP tools/list filters out forbidden tools", async () => {
    const r = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Cf-Connecting-Ip": "1.2.3.4",
        "Authorization": `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { result: { tools: { name: string }[] } };
    const names = body.result.tools.map((t) => t.name).sort();
    expect(names).not.toContain("index");
    expect(names).not.toContain("log_friction");
    expect(names).toContain("search");
  });

  it("internal MCP tools/list returns full set", async () => {
    const r = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      }),
    });
    const body = (await r.json()) as { result: { tools: { name: string }[] } };
    const names = body.result.tools.map((t) => t.name).sort();
    expect(names).toContain("index");
    expect(names).toContain("log_friction");
  });

  it("public MCP tools/call name=index → JSON-RPC error", async () => {
    const r = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Cf-Connecting-Ip": "1.2.3.4",
        "Authorization": `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "index", arguments: { sourcePath: "x.md", text: "hi" } },
      }),
    });
    const body = (await r.json()) as { error?: { code: number; message: string } };
    expect(body.error?.code).toBe(-32600);
    expect(body.error?.message).toMatch(/not callable from the public/);
  });

  it("public MCP tools/call name=stats works with bearer", async () => {
    const r = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Cf-Connecting-Ip": "1.2.3.4",
        "Authorization": `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "stats" },
      }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { result: { content: { text: string }[] } };
    expect(body.result.content[0]?.text).toMatch(/documents/);
  });
});

describe("MEMEX_PUBLIC_WRITE opt-in", () => {
  const ORIGINAL = process.env["MEMEX_PUBLIC_WRITE"];
  beforeEach(() => {
    process.env["MEMEX_PUBLIC_WRITE"] = "1";
  });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env["MEMEX_PUBLIC_WRITE"];
    else process.env["MEMEX_PUBLIC_WRITE"] = ORIGINAL;
  });

  it("isPublicMcpToolForbidden returns false for write tools when env=1", () => {
    expect(isPublicMcpToolForbidden("index")).toBe(false);
    expect(isPublicMcpToolForbidden("log_friction")).toBe(false);
  });

  it("evaluatePublicGuard allows /index POST with bearer when env=1", () => {
    const req = new Request("http://x/index", {
      method: "POST",
      headers: {
        "Cf-Connecting-Ip": "1.2.3.4",
        "Authorization": `Bearer ${TOKEN}`,
      },
    });
    const r = evaluatePublicGuard(req, new URL("http://x/index"), {
      bearerToken: TOKEN,
    });
    expect(r.allow).toBe(true);
  });

  it("still 401s on missing bearer even with public-write enabled", () => {
    const req = new Request("http://x/index", {
      method: "POST",
      headers: { "Cf-Connecting-Ip": "1.2.3.4" },
    });
    const r = evaluatePublicGuard(req, new URL("http://x/index"), {
      bearerToken: TOKEN,
    });
    expect(r.allow).toBe(false);
    if (!r.allow) expect(r.status).toBe(401);
  });
});
