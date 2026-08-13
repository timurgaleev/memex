/**
 * The internal-token gate on `POST /mcp`.
 *
 * A compromised sibling on the docker bridge could once call
 * `tools/call name=index` (or any write tool) with no token and poison the
 * corpus. The gate closed that for writes — and left every READ tool open,
 * because the guard treated "arrived without Cf-Connecting-Ip" as sufficient
 * on its own. It is not: `MEMEX_INTERNAL_TOKEN` is the credential for that
 * ingress, so when it is configured the whole surface asks for it, at the
 * ingress, before a tool name is even parsed. Unset, the legacy fall-through
 * still waves the bridge through (serve.ts warns loudly at boot).
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

async function post(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${url}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function rpc(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<any> {
  return (await post(url, body, headers)).json();
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

  it("internal write tool WITHOUT token → 401 at the ingress", async () => {
    // REWRITTEN: this asserted the JSON-RPC -32001 wall, i.e. that a
    // credential-less request got as far as the dispatcher and was turned away
    // by tool name. It is refused before that now, so the wall is unreachable
    // from HTTP with the token configured (it still covers handler callers —
    // see request_log_db.test.ts).
    const r = await post(url, writeCall);
    expect(r.status).toBe(401);
    expect(((await r.json()) as { error: string }).error).toMatch(
      /internal token/,
    );
  });

  it("internal write tool WITH correct token → passes the gate", async () => {
    const r = await rpc(url, writeCall, {
      Authorization: `Bearer ${INT_TOKEN}`,
    });
    expect(r.error).toBeUndefined();
    const parsed = JSON.parse(r.result.content[0].text);
    expect(parsed.ok).toBe(true);
  });

  it("internal write tool WITH wrong token → 401 at the ingress", async () => {
    const r = await post(url, writeCall, { Authorization: "Bearer NOPE" });
    expect(r.status).toBe(401);
  });

  const readCall = {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "whoami" },
  };

  it("internal READ tool WITHOUT token → 401", async () => {
    // REWRITTEN: the old assertion ("allowed — the gate is forbid-public-only")
    // was the defect written down as a fixture. whoami is a plain read, and a
    // plain read is exactly what a compromised sibling on the bridge wants;
    // letting it through unauthenticated made the credential optional for the
    // entire read surface.
    const r = await post(url, readCall);
    expect(r.status).toBe(401);
  });

  it("internal READ tool WITH the token → allowed", async () => {
    const r = await rpc(url, readCall, {
      Authorization: `Bearer ${INT_TOKEN}`,
    });
    expect(r.error).toBeUndefined();
    const parsed = JSON.parse(r.result.content[0].text);
    expect(parsed.ok).toBe(true);
  });

  it("GET /health stays open with the token configured (docker healthcheck)", async () => {
    const r = await fetch(`${url}/health`);
    expect(r.status).toBe(200);
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

  it("internal READ tool WITHOUT token → allowed (the escape hatch is not narrowed)", async () => {
    // An install that never configured the secret must keep working; tightening
    // the ingress must not lock it out overnight.
    const r = await rpc(url, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "whoami" },
    });
    expect(r.error).toBeUndefined();
    expect(JSON.parse(r.result.content[0].text).ok).toBe(true);
  });
});
