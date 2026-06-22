/**
 * MCP HTTP transport tests — exercise initialize / tools/list / tools/call
 * over a real Bun.serve and a fresh PGLite. Avoids Bedrock by seeding the
 * DB directly and only testing the cheap tools (stats, backlinks).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { startServer, type ServerHandle } from "../src/http/server.ts";
import { RateLimiter } from "../src/mcp/rate_limit.ts";
import { TOOL_DEFS } from "../src/mcp/tool_defs.ts";

let tmp: string;
let storage: Storage;
let server: ServerHandle;
let url: string;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-mcp-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  server = startServer({ host: "127.0.0.1", port: 0, storage });
  url = `http://127.0.0.1:${server.port}/mcp`;
});

afterEach(async () => {
  await server.stop();
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function rpc(body: unknown): Promise<any> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}

describe("MCP HTTP transport", () => {
  it("rejects GET", async () => {
    const r = await fetch(url, { method: "GET" });
    expect(r.status).toBe(405);
  });

  it("returns parse error on bad JSON", async () => {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(body.error.code).toBe(-32700);
  });

  it("initialize returns server info + protocol version", async () => {
    const r = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize" });
    expect(r.result.serverInfo.name).toBe("memex");
    expect(r.result.protocolVersion).toBeTruthy();
    expect(r.result.capabilities.tools).toBeDefined();
  });

  it("tools/list returns the registered tools", async () => {
    const r = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(r.result.tools.length).toBe(TOOL_DEFS.length);
    const names = r.result.tools.map((t: any) => t.name).sort();
    expect(names).toEqual([
      "add_fact",
      "add_timeline_event",
      "backlinks",
      "entity_facts",
      "entity_recall",
      "entity_timeline",
      "graph_neighbors",
      "graph_query",
      "index",
      "jobs_cancel",
      "jobs_get",
      "jobs_list",
      "jobs_logs",
      "jobs_submit",
      "link",
      "log_friction",
      "page_append",
      "page_delete",
      "page_get",
      "page_list",
      "page_put",
      "page_restore",
      "page_revert",
      "page_versions",
      "search",
      "stats",
      "traverse_graph",
      "unlink",
    ]);
  });

  it("tools/call stats returns counts", async () => {
    const r = await rpc({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "stats" },
    });
    expect(r.result.content[0].type).toBe("text");
    const parsed = JSON.parse(r.result.content[0].text);
    expect(parsed.documents).toBe(0);
    expect(parsed.chunks).toBe(0);
  });

  it("tools/call unknown returns isError content (not JSON-RPC error)", async () => {
    const r = await rpc({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "no-such-tool" },
    });
    expect(r.result.isError).toBe(true);
    // The stable contract is the structured `error` code, not the prose — this
    // request is internal ingress (no bearer) so the message is also present,
    // but assert on the code so the test survives the public message-drop.
    const env = JSON.parse(r.result.content[0].text);
    expect(env.error).toBe("not_found");
    expect(env.message).toMatch(/unknown tool/);
  });

  it("unknown method returns -32601", async () => {
    const r = await rpc({ jsonrpc: "2.0", id: 5, method: "no-method" });
    expect(r.error.code).toBe(-32601);
  });

  it("malformed JSON-RPC envelope returns -32600", async () => {
    const r = await rpc({ id: 6, method: "tools/list" }); // no jsonrpc field
    expect(r.error.code).toBe(-32600);
  });

  it("batch request returns batch response", async () => {
    const r = await rpc([
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ]);
    expect(Array.isArray(r)).toBe(true);
    expect(r.length).toBe(2);
    expect(r[0].result).toEqual({});
    expect(r[1].result.tools.length).toBe(TOOL_DEFS.length);
  });
});

describe("RateLimiter", () => {
  it("allows up to capacity, then blocks", () => {
    const r = new RateLimiter({ capacity: 3, refillPerSecond: 0 });
    expect(r.allow("a")).toBe(true);
    expect(r.allow("a")).toBe(true);
    expect(r.allow("a")).toBe(true);
    expect(r.allow("a")).toBe(false);
  });

  it("isolates buckets per key", () => {
    const r = new RateLimiter({ capacity: 1, refillPerSecond: 0 });
    expect(r.allow("a")).toBe(true);
    expect(r.allow("a")).toBe(false);
    expect(r.allow("b")).toBe(true);
  });

  it("refills over time", () => {
    const r = new RateLimiter({ capacity: 1, refillPerSecond: 1 });
    expect(r.allow("x", 1000)).toBe(true);
    expect(r.allow("x", 1500)).toBe(false); // 0.5 token, not enough
    expect(r.allow("x", 2100)).toBe(true); // 1.1 → enough
  });
});
