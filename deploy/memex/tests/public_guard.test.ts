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

  it("blocks graph writes (link, unlink)", () => {
    expect(isPublicMcpToolForbidden("link")).toBe(true);
    expect(isPublicMcpToolForbidden("unlink")).toBe(true);
  });

  it("blocks entity-fact / timeline writes (add_fact, add_timeline_event)", () => {
    expect(isPublicMcpToolForbidden("add_fact")).toBe(true);
    expect(isPublicMcpToolForbidden("add_timeline_event")).toBe(true);
  });

  it("blocks jobs writes (jobs_submit, jobs_cancel)", () => {
    expect(isPublicMcpToolForbidden("jobs_submit")).toBe(true);
    expect(isPublicMcpToolForbidden("jobs_cancel")).toBe(true);
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

  it("allows graph reads (graph_neighbors, graph_query)", () => {
    expect(isPublicMcpToolForbidden("graph_neighbors")).toBe(false);
    expect(isPublicMcpToolForbidden("graph_query")).toBe(false);
  });

  it("allows entity reads (entity_facts, entity_timeline, entity_recall)", () => {
    expect(isPublicMcpToolForbidden("entity_facts")).toBe(false);
    expect(isPublicMcpToolForbidden("entity_timeline")).toBe(false);
    expect(isPublicMcpToolForbidden("entity_recall")).toBe(false);
  });

  it("allows jobs reads (jobs_list, jobs_get, jobs_logs)", () => {
    expect(isPublicMcpToolForbidden("jobs_list")).toBe(false);
    expect(isPublicMcpToolForbidden("jobs_get")).toBe(false);
    expect(isPublicMcpToolForbidden("jobs_logs")).toBe(false);
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

  it("internal /index is gone (A.7) — passes the guard, then 404s", async () => {
    // The legacy REST /index route was removed in A.7; indexing now flows
    // through MCP `tools/call name=index`. An internal request (no
    // Cf-Connecting-Ip) clears the guard but finds no route → 404.
    const r = await fetch(`${url}/index`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(404);
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

  it("opens only constructive writes when env=1; destructive + reads stay internal", () => {
    // Constructive knowledge-writes open.
    expect(isPublicMcpToolForbidden("index")).toBe(false);
    expect(isPublicMcpToolForbidden("page_put")).toBe(false);
    expect(isPublicMcpToolForbidden("page_append")).toBe(false);
    expect(isPublicMcpToolForbidden("add_fact")).toBe(false);
    expect(isPublicMcpToolForbidden("add_timeline_event")).toBe(false);
    expect(isPublicMcpToolForbidden("add_tag")).toBe(false);
    expect(isPublicMcpToolForbidden("link")).toBe(false);
    // Destructive writes stay forbidden even with the flag on.
    expect(isPublicMcpToolForbidden("page_delete")).toBe(true);
    expect(isPublicMcpToolForbidden("page_revert")).toBe(true);
    expect(isPublicMcpToolForbidden("unlink")).toBe(true);
    expect(isPublicMcpToolForbidden("remove_tag")).toBe(true);
    expect(isPublicMcpToolForbidden("forget_fact")).toBe(true);
    expect(isPublicMcpToolForbidden("log_friction")).toBe(true);
    // Privacy-sensitive content / identifier reads stay forbidden too.
    expect(isPublicMcpToolForbidden("get_chunks")).toBe(true);
    expect(isPublicMcpToolForbidden("recall")).toBe(true);
    expect(isPublicMcpToolForbidden("query")).toBe(true);
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

  it("public MCP index with server `path` is blocked even with the write flag on", async () => {
    // The gate lets `index` through (it's a constructive write), but the
    // handler rejects the filesystem-`path` form on the public ingress —
    // remote callers must index inline. Errors before any file read / embed.
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
        params: { name: "index", arguments: { path: "/etc/passwd" } },
      }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      result?: { content?: { text?: string }[] };
    };
    expect(JSON.stringify(body)).toMatch(/internal-only/);
  });
});
