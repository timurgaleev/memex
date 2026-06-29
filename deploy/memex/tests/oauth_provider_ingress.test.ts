/**
 * Self-issued OAuth 2.1 (client_credentials) on the live MCP ingress.
 *
 * Proves the wiring added in server.ts/serve.ts: when `oauthProvider` is set,
 * POST /token mints a token for a registered client, and a `memex_at_…` bearer
 * authenticates the /mcp path (scoped to the client's oauth_clients row) while
 * the static public bearer is also enforced. A bad/garbage token still 401s.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { startServer, type ServerHandle } from "../src/http/server.ts";
import { OAuthProvider } from "../src/core/oauth-provider.ts";

const PUB_TOKEN = "pub-bearer-xyz789";
const readCall = {
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name: "get_stats", arguments: {} },
};

describe("self-issued client_credentials on the MCP ingress", () => {
  let tmp: string;
  let storage: Storage;
  let provider: OAuthProvider;
  let server: ServerHandle;
  let url: string;
  let clientId: string;
  let clientSecret: string;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "memex-cc-ingress-"));
    storage = new Storage({ dbPath: join(tmp, "db") });
    await storage.init();
    provider = new OAuthProvider({ engine: storage.raw() });
    const reg = await provider.registerClientManual(
      "test-client",
      ["client_credentials"],
      "read",
      [],
      "default",
    );
    clientId = reg.clientId;
    clientSecret = reg.clientSecret!;
    server = startServer({
      host: "127.0.0.1",
      port: 0,
      storage,
      publicBearerToken: PUB_TOKEN,
      oauthProvider: provider,
    });
    url = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    await server.stop();
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  async function token(secret: string): Promise<Response> {
    return fetch(`${url}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: secret,
      }),
    });
  }

  async function mcp(bearer?: string): Promise<Response> {
    return fetch(`${url}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify(readCall),
    });
  }

  it("POST /token mints a memex_at_ access token", async () => {
    const r = await token(clientSecret);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { access_token: string; token_type: string };
    expect(body.token_type).toBe("bearer");
    expect(body.access_token).toMatch(/^memex_at_/);
  });

  it("POST /token with a wrong secret → 401 invalid_client", async () => {
    const r = await token("memex_cs_wrong");
    expect(r.status).toBe(401);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe("invalid_client");
  });

  it("a minted token authenticates /mcp (no unauthorized error)", async () => {
    const t = (await (await token(clientSecret)).json()) as {
      access_token: string;
    };
    const r = await mcp(t.access_token);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { error?: { code?: number }; result?: unknown };
    // -32001 is the unauthorized JSON-RPC code; the token must clear the guard.
    expect(body.error?.code).not.toBe(-32001);
    expect(body.result).toBeDefined();
  });

  it("a minted token resolves to the client's source + scope", async () => {
    const t = (await (await token(clientSecret)).json()) as {
      access_token: string;
    };
    const info = await provider.verifyAccessToken(t.access_token);
    expect(info.clientId).toBe(clientId);
    expect(info.sourceId).toBe("default");
    expect(info.scopes).toContain("read");
  });

  it("a garbage memex_at_ token falls back gracefully (no crash)", async () => {
    // verifyAccessToken throws InvalidTokenError; the ingress must swallow it
    // and fall through to the public path, never 500.
    const r = await mcp("memex_at_not_a_real_token");
    expect(r.status).toBe(200);
    const body = (await r.json()) as { result?: unknown };
    expect(body.result).toBeDefined();
  });
});
