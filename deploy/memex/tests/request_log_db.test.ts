/**
 * MCP request-log DB sink (opt-in MEMEX_REQUEST_LOG_DB). Inserts one redacted
 * row per tool call into mcp_request_log; no-op when disabled; fire-and-forget.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { logToolCallToDb, requestLogDbEnabled } from "../src/core/../mcp/request-log-db.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-reqlogdb-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});
afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
  delete process.env["MEMEX_REQUEST_LOG_DB"];
});

async function rowCount(): Promise<number> {
  const r = await storage.engine().query<{ n: number }>("SELECT count(*)::int AS n FROM mcp_request_log");
  return r.rows[0]?.n ?? 0;
}

describe("logToolCallToDb", () => {
  it("is a no-op when the flag is off", async () => {
    expect(requestLogDbEnabled()).toBe(false);
    logToolCallToDb(storage.engine(), { tool: "search", agentName: "public", latencyMs: 5, ok: true, params: { q: "x" } });
    await new Promise((r) => setTimeout(r, 30));
    expect(await rowCount()).toBe(0);
  });

  it("inserts a redacted row when enabled (known tool, summary params)", async () => {
    process.env["MEMEX_REQUEST_LOG_DB"] = "1";
    logToolCallToDb(storage.engine(), { tool: "search", agentName: "client-1", latencyMs: 12, ok: true, params: { q: "secret query" } });
    await new Promise((r) => setTimeout(r, 50)); // let the detached insert land
    const r = await storage.engine().query<{ operation: string; agent_name: string; status: string; latency_ms: number; params: unknown }>(
      "SELECT operation, agent_name, status, latency_ms, params FROM mcp_request_log LIMIT 1",
    );
    const row = r.rows[0]!;
    expect(row.operation).toBe("search");
    expect(row.agent_name).toBe("client-1");
    expect(row.status).toBe("success");
    expect(row.latency_ms).toBe(12);
    // Redacted: the raw "secret query" must NOT appear in the stored summary.
    expect(JSON.stringify(row.params)).not.toContain("secret query");
  });

  it("stores an unknown tool name as 'unknown' (no raw caller input)", async () => {
    process.env["MEMEX_REQUEST_LOG_DB"] = "1";
    logToolCallToDb(storage.engine(), { tool: "../etc/passwd", agentName: "x", latencyMs: 1, ok: false, params: {} });
    await new Promise((r) => setTimeout(r, 50));
    const r = await storage.engine().query<{ operation: string; status: string }>("SELECT operation, status FROM mcp_request_log LIMIT 1");
    expect(r.rows[0]?.operation).toBe("unknown");
    expect(r.rows[0]?.status).toBe("error");
  });
});
