/**
 * MCP write-tools internal-token gate.
 *
 * The HTTP `/index` route already requires `MEMEX_INTERNAL_TOKEN` for
 * internal mutating traffic, but the MCP JSON-RPC surface (`POST /mcp`)
 * did not — a compromised sibling on the docker bridge could call
 * `tools/call name=index` (or any write tool) with no token and poison
 * the corpus. This locks the gate: write tools
 * (`FORBIDDEN_MCP_TOOLS_FROM_PUBLIC`) now require the token on the
 * internal path; read tools and the public ingress are unaffected.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { startServer, type ServerHandle } from "../src/http/server.ts";

const PUB_TOKEN = "pub-bearer-xyz789";
const INT_TOKEN = "internal-shared-token-abcdef";
const ERR_UNAUTHORIZED = -32001;

let tmp: string;
let storage: Storage;

async function rpc(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<any> {
  const r = await fetch(`${url}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return r.json();
}

const writeCall = {
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name: "page_put", arguments: { slug: "gate-test", type: "note" } },
};

// ---------------------------------------------------------------------------
// Token CONFIGURED — gate is live
// ---------------------------------------------------------------------------

describe("MCP write-tools gate (internal token configured)", () => {
  let server: ServerHandle;
  let url: string;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "memex-mcp-inttok-"));
    storage = new Storage({ dbPath: join(tmp, "db") });
    await storage.init();
    server = startServer({
      host: "127.0.0.1",
      port: 0,
      storage,
      publicBearerToken: PUB_TOKEN,
      internalToken: INT_TOKEN,
    });
    url = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    await server.stop();
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("internal write tool WITHOUT token → unauthorized", async () => {
    const r = await rpc(url, writeCall);
    expect(r.error?.code).toBe(ERR_UNAUTHORIZED);
    expect(r.error.message).toMatch(/internal token/);
  });

  it("internal write tool WITH correct token → passes the gate", async () => {
    const r = await rpc(url, writeCall, {
      Authorization: `Bearer ${INT_TOKEN}`,
    });
    expect(r.error).toBeUndefined();
    const parsed = JSON.parse(r.result.content[0].text);
    expect(parsed.ok).toBe(true);
  });

  it("internal write tool WITH wrong token → unauthorized", async () => {
    const r = await rpc(url, writeCall, { Authorization: "Bearer NOPE" });
    expect(r.error?.code).toBe(ERR_UNAUTHORIZED);
  });

  it("internal READ tool WITHOUT token → allowed (gate is write-only)", async () => {
    const r = await rpc(url, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "stats" },
    });
    expect(r.error).toBeUndefined();
    const parsed = JSON.parse(r.result.content[0].text);
    expect(parsed.ok).toBe(true);
  });

  it("public write tool → forbidden by the public guard (token irrelevant)", async () => {
    const r = await rpc(url, writeCall, {
      "Cf-Connecting-Ip": "1.2.3.4",
      Authorization: `Bearer ${PUB_TOKEN}`,
    });
    // Public forbid fires before the internal-token check.
    expect(r.error).toBeDefined();
    expect(r.error.code).not.toBe(ERR_UNAUTHORIZED);
    expect(r.error.message).toMatch(/not callable from the public ingress/);
  });
});

// ---------------------------------------------------------------------------
// Token UNSET — legacy fallthrough (gate is a no-op until configured)
// ---------------------------------------------------------------------------

describe("MCP write-tools gate (internal token unset)", () => {
  let server: ServerHandle;
  let url: string;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "memex-mcp-inttok-off-"));
    storage = new Storage({ dbPath: join(tmp, "db") });
    await storage.init();
    server = startServer({ host: "127.0.0.1", port: 0, storage });
    url = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    await server.stop();
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("internal write tool WITHOUT token → allowed (legacy fallthrough)", async () => {
    const r = await rpc(url, writeCall);
    expect(r.error).toBeUndefined();
    const parsed = JSON.parse(r.result.content[0].text);
    expect(parsed.ok).toBe(true);
  });
});
