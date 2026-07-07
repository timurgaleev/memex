/**
 * Admin data + provisioning endpoints (increment A2). Each route 401s without
 * an admin session, then wraps memex's tenant provisioning + brain stats.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { createAdminAuth } from "../src/http/admin.ts";
import { handleAdminApi } from "../src/http/admin-api.ts";
import { OAuthProvider } from "../src/core/oauth-provider.ts";

const BOOT = "boot-secret";
let tmp: string;
let storage: Storage;
let auth: ReturnType<typeof createAdminAuth>;
let cookie: string;

function req(path: string, init?: RequestInit): Request {
  return new Request(`http://localhost:8080${path}`, init);
}
async function call(path: string, init?: RequestInit): Promise<Response | null> {
  return handleAdminApi(req(path, init), new URL(`http://localhost:8080${path}`), {
    storage,
    requireAdmin: auth.requireAdmin,
  });
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-adminapi-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  auth = createAdminAuth({ bootstrapToken: BOOT });
  const login = await auth.handleAuthRoute(
    req("/admin/login", { method: "POST", body: JSON.stringify({ token: BOOT }) }),
    new URL("http://localhost:8080/admin/login"),
  );
  cookie = (login!.headers.get("Set-Cookie") ?? "").split(";")[0]!;
});
afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

const authed = (extra?: RequestInit): RequestInit => ({ ...extra, headers: { ...(extra?.headers ?? {}), cookie } });

describe("admin-api auth gating", () => {
  it("401s every data route without a session", async () => {
    expect((await call("/admin/api/full-stats"))?.status).toBe(401);
    expect((await call("/admin/api/grants"))?.status).toBe(401);
    expect((await call("/admin/api/sources", { method: "POST", body: "{}" }))?.status).toBe(401);
    expect((await call("/admin/api/grants", { method: "POST", body: "{}" }))?.status).toBe(401);
    expect((await call("/admin/api/revoke-grant", { method: "POST", body: "{}" }))?.status).toBe(401);
    expect((await call("/admin/api/agent-config?sub=user-1"))?.status).toBe(401);
    expect((await call("/admin/api/agents"))?.status).toBe(401);
    expect((await call("/admin/api/api-keys"))?.status).toBe(401);
    expect((await call("/admin/api/api-keys", { method: "POST", body: "{}" }))?.status).toBe(401);
    expect((await call("/admin/api/api-keys/revoke", { method: "POST", body: "{}" }))?.status).toBe(401);
    expect((await call("/admin/api/register-client", { method: "POST", body: "{}" }))?.status).toBe(401);
    expect((await call("/admin/api/update-client-ttl", { method: "POST", body: "{}" }))?.status).toBe(401);
    expect((await call("/admin/api/revoke-client", { method: "POST", body: "{}" }))?.status).toBe(401);
  });
  it("401s an unknown /admin/api path when unauthenticated (no path disclosure)", async () => {
    expect((await call("/admin/api/nope"))?.status).toBe(401);
  });
  it("returns null for an authed unknown /admin/api path (falls through to 404)", async () => {
    expect(await call("/admin/api/nope", authed())).toBeNull();
  });
});

describe("admin-api provisioning (authed)", () => {
  it("registers a source, grants a subject, lists, then revokes", async () => {
    // Register a tenant source.
    const src = await call("/admin/api/sources", authed({ method: "POST", body: JSON.stringify({ id: "acme", name: "Acme" }) }));
    expect(src?.status).toBe(200);

    // Grant a JWT subject.
    const grant = await call("/admin/api/grants", authed({ method: "POST", body: JSON.stringify({ sub: "user-1", source: "acme" }) }));
    expect(grant?.status).toBe(200);

    // List shows it.
    const list = await call("/admin/api/grants", authed());
    const body = (await list!.json()) as { count: number; grants: Array<{ sub: string }> };
    expect(body.count).toBe(1);
    expect(body.grants[0]?.sub).toBe("user-1");

    // Revoke.
    const rev = await call("/admin/api/revoke-grant", authed({ method: "POST", body: JSON.stringify({ sub: "user-1" }) }));
    expect((await rev!.json() as { removed: boolean }).removed).toBe(true);
  });

  it("enriches each grant with per-subject usage joined on agent_name = sub", async () => {
    await call("/admin/api/sources", authed({ method: "POST", body: JSON.stringify({ id: "acme" }) }));
    await call("/admin/api/grants", authed({ method: "POST", body: JSON.stringify({ sub: "agent-x", source: "acme" }) }));
    await call("/admin/api/grants", authed({ method: "POST", body: JSON.stringify({ sub: "agent-y", source: "acme" }) }));

    const e = storage.engine();
    // agent-x: 2 requests today + 1 old; agent-y: no logged calls.
    await e.query(
      `INSERT INTO mcp_request_log (agent_name, operation, status, created_at) VALUES
         ('agent-x', 'search',   'success', now()),
         ('agent-x', 'get_page', 'success', now()),
         ('agent-x', 'search',   'success', now() - interval '3 days'),
         ('other',   'search',   'success', now())`,
    );

    const list = await call("/admin/api/grants", authed());
    const body = (await list!.json()) as {
      count: number;
      grants: Array<{
        sub: string;
        usage: { requests_today: number; total_requests: number; last_used_at: string | null };
      }>;
    };
    expect(body.count).toBe(2);
    const x = body.grants.find((g) => g.sub === "agent-x")!;
    const y = body.grants.find((g) => g.sub === "agent-y")!;
    expect(x.usage.total_requests).toBe(3);
    expect(x.usage.requests_today).toBe(2);
    expect(x.usage.last_used_at).not.toBeNull();
    // A subject with no logged calls gets a zeroed block, never null.
    expect(y.usage).toEqual({ requests_today: 0, total_requests: 0, last_used_at: null });
  });

  it("rejects a grant to an unknown source (400)", async () => {
    const r = await call("/admin/api/grants", authed({ method: "POST", body: JSON.stringify({ sub: "u", source: "ghost" }) }));
    expect(r?.status).toBe(400);
  });

  it("rejects a malformed `read` (400, never silently coerced)", async () => {
    await call("/admin/api/sources", authed({ method: "POST", body: JSON.stringify({ id: "acme" }) }));
    const bad = await call("/admin/api/grants", authed({ method: "POST", body: JSON.stringify({ sub: "u", source: "acme", read: "acme" }) }));
    expect(bad?.status).toBe(400); // read is a string, not a non-empty string[]
    const empty = await call("/admin/api/grants", authed({ method: "POST", body: JSON.stringify({ sub: "u", source: "acme", read: [] }) }));
    expect(empty?.status).toBe(400);
  });

  it("full-stats returns health + corpus counts", async () => {
    const r = await call("/admin/api/full-stats", authed());
    expect(r?.status).toBe(200);
    const body = (await r!.json()) as { health: unknown; counts: { documents: number } | null };
    expect(body.health).toBeDefined();
    expect(body.counts).not.toBeNull();
  });

  it("requests returns a paginated (empty) request log", async () => {
    const r = await call("/admin/api/requests?page=1", authed());
    expect(r?.status).toBe(200);
    const body = (await r!.json()) as { page: number; total: number; rows: unknown[] };
    expect(body.page).toBe(1);
    expect(Array.isArray(body.rows)).toBe(true);
  });

  it("jobs/watch returns status counts + recent jobs", async () => {
    const e = storage.engine();
    await e.query(`INSERT INTO jobs (id, kind, status) VALUES ('j1','sweep','succeeded')`);
    const r = await call("/admin/api/jobs/watch", authed());
    expect(r?.status).toBe(200);
    const body = (await r!.json()) as { counts: { status: string; n: number }[]; recent: { kind: string }[] };
    expect(body.counts.find((c) => c.status === "succeeded")?.n).toBe(1);
    expect(body.recent[0]?.kind).toBe("sweep");
  });

  it("requests + jobs/watch 401 without a session", async () => {
    expect((await call("/admin/api/requests"))?.status).toBe(401);
    expect((await call("/admin/api/jobs/watch"))?.status).toBe(401);
  });

  it("calibration/profile returns null when none computed, gated when unauth", async () => {
    expect((await call("/admin/api/calibration/profile"))?.status).toBe(401);
    const r = await call("/admin/api/calibration/profile", authed());
    expect(r?.status).toBe(200);
    const body = (await r!.json()) as { profile: unknown };
    expect(body.profile).toBeNull(); // fresh brain — no synthesis calibration run yet
  });
});

interface AgentRow {
  auth_type: "oauth" | "api_key";
  id: string;
  name: string;
  scope: string | null;
  token_ttl: number | null;
  status: string;
  usage: { requests_today: number; total_requests: number; last_used_at: string | null };
}

describe("admin-api credential management (authed)", () => {
  it("mints, lists, and revokes an API key; the token verifies until revoked", async () => {
    const mint = await call("/admin/api/api-keys", authed({ method: "POST", body: JSON.stringify({ name: "key-1" }) }));
    expect(mint?.status).toBe(200);
    const minted = (await mint!.json()) as { ok: boolean; name: string; token: string };
    expect(minted.ok).toBe(true);
    expect(minted.token.startsWith("memex_")).toBe(true);

    // Only the hash persists — the plaintext never touches the table.
    const stored = await storage.engine().query<{ token_hash: string }>(
      "SELECT token_hash FROM access_tokens WHERE name = 'key-1'",
    );
    expect(stored.rows[0]?.token_hash).not.toBe(minted.token);

    // The minted token authenticates through the legacy verify path.
    const provider = new OAuthProvider({ engine: storage.engine() });
    const info = await provider.verifyAccessToken(minted.token);
    expect(info.clientName).toBe("key-1");

    // A second active key with the same name is rejected.
    const dup = await call("/admin/api/api-keys", authed({ method: "POST", body: JSON.stringify({ name: "key-1" }) }));
    expect(dup?.status).toBe(400);

    // List shows it active.
    const list = await call("/admin/api/api-keys", authed());
    const listBody = (await list!.json()) as { count: number; keys: Array<{ name: string; status: string }> };
    expect(listBody.keys.find((k) => k.name === "key-1")?.status).toBe("active");

    // Revoke; the token stops verifying and a second revoke 404s.
    const rev = await call("/admin/api/api-keys/revoke", authed({ method: "POST", body: JSON.stringify({ name: "key-1" }) }));
    expect(rev?.status).toBe(200);
    await expect(provider.verifyAccessToken(minted.token)).rejects.toThrow();
    const again = await call("/admin/api/api-keys/revoke", authed({ method: "POST", body: JSON.stringify({ name: "key-1" }) }));
    expect(again?.status).toBe(404);
  });

  it("registers an OAuth client with a token_ttl the exchange honors", async () => {
    const reg = await call(
      "/admin/api/register-client",
      authed({ method: "POST", body: JSON.stringify({ name: "agent-a", scopes: "read write", token_ttl: 120 }) }),
    );
    expect(reg?.status).toBe(200);
    const body = (await reg!.json()) as {
      ok: boolean;
      client_id: string;
      client_secret: string | null;
      grant_types: string[];
      token_ttl: number | null;
    };
    expect(body.client_id.startsWith("memex_cl_")).toBe(true);
    expect(body.client_secret?.startsWith("memex_cs_")).toBe(true);
    expect(body.grant_types).toEqual(["client_credentials"]); // no redirect_uris → machine client
    expect(body.token_ttl).toBe(120);

    // The half-wired TTL write side is closed: the exchange reads it back.
    const provider = new OAuthProvider({ engine: storage.engine() });
    const tokens = await provider.exchangeClientCredentials(body.client_id, body.client_secret!, "read");
    expect(tokens.expires_in).toBe(120);
  });

  it("defaults browser clients to authorization_code grants and 400s malformed input", async () => {
    const reg = await call(
      "/admin/api/register-client",
      authed({
        method: "POST",
        body: JSON.stringify({ name: "web", redirect_uris: ["https://example.com/cb"] }),
      }),
    );
    const body = (await reg!.json()) as { grant_types: string[] };
    expect(body.grant_types).toEqual(["authorization_code", "refresh_token"]);

    const badScope = await call(
      "/admin/api/register-client",
      authed({ method: "POST", body: JSON.stringify({ name: "x", scopes: ["read write"] }) }),
    );
    expect(badScope?.status).toBe(400); // space-in-element array shape

    const badTtl = await call(
      "/admin/api/register-client",
      authed({ method: "POST", body: JSON.stringify({ name: "x", token_ttl: -5 }) }),
    );
    expect(badTtl?.status).toBe(400);

    const ghostSource = await call(
      "/admin/api/register-client",
      authed({ method: "POST", body: JSON.stringify({ name: "x", source: "ghost" }) }),
    );
    expect(ghostSource?.status).toBe(400); // explicit tenancy grant is validated
  });

  it("update-client-ttl sets and clears the override, 404s unknown clients", async () => {
    const reg = await call(
      "/admin/api/register-client",
      authed({ method: "POST", body: JSON.stringify({ name: "agent-b" }) }),
    );
    const { client_id } = (await reg!.json()) as { client_id: string };

    const set = await call(
      "/admin/api/update-client-ttl",
      authed({ method: "POST", body: JSON.stringify({ client_id, token_ttl: 900 }) }),
    );
    expect(set?.status).toBe(200);
    let row = await storage.engine().query<{ token_ttl: number | null }>(
      "SELECT token_ttl FROM oauth_clients WHERE client_id = $1",
      [client_id],
    );
    expect(Number(row.rows[0]?.token_ttl)).toBe(900);

    // null clears back to the server default.
    const clear = await call(
      "/admin/api/update-client-ttl",
      authed({ method: "POST", body: JSON.stringify({ client_id, token_ttl: null }) }),
    );
    expect(clear?.status).toBe(200);
    row = await storage.engine().query<{ token_ttl: number | null }>(
      "SELECT token_ttl FROM oauth_clients WHERE client_id = $1",
      [client_id],
    );
    expect(row.rows[0]?.token_ttl).toBeNull();

    const missing = await call(
      "/admin/api/update-client-ttl",
      authed({ method: "POST", body: JSON.stringify({ client_id: "nope", token_ttl: 60 }) }),
    );
    expect(missing?.status).toBe(404);

    const bad = await call(
      "/admin/api/update-client-ttl",
      authed({ method: "POST", body: JSON.stringify({ client_id, token_ttl: "soon" }) }),
    );
    expect(bad?.status).toBe(400);
  });

  it("revoke-client soft-deletes and kills live tokens", async () => {
    const reg = await call(
      "/admin/api/register-client",
      authed({ method: "POST", body: JSON.stringify({ name: "agent-c", scopes: "read" }) }),
    );
    const { client_id, client_secret } = (await reg!.json()) as { client_id: string; client_secret: string };

    const provider = new OAuthProvider({ engine: storage.engine() });
    const tokens = await provider.exchangeClientCredentials(client_id, client_secret);
    await provider.verifyAccessToken(tokens.access_token); // live before revoke

    const rev = await call(
      "/admin/api/revoke-client",
      authed({ method: "POST", body: JSON.stringify({ client_id }) }),
    );
    expect(rev?.status).toBe(200);
    const revBody = (await rev!.json()) as { revoked: boolean; tokens_deleted: number };
    expect(revBody.revoked).toBe(true);
    expect(revBody.tokens_deleted).toBeGreaterThan(0);

    // Both the issued token and fresh exchanges are dead.
    await expect(provider.verifyAccessToken(tokens.access_token)).rejects.toThrow();
    await expect(provider.exchangeClientCredentials(client_id, client_secret)).rejects.toThrow();

    const missing = await call(
      "/admin/api/revoke-client",
      authed({ method: "POST", body: JSON.stringify({ client_id: "nope" }) }),
    );
    expect(missing?.status).toBe(404);
  });

  it("agents view unifies OAuth clients + API keys with per-credential usage", async () => {
    const reg = await call(
      "/admin/api/register-client",
      authed({ method: "POST", body: JSON.stringify({ name: "agent-d", token_ttl: 60 }) }),
    );
    const { client_id } = (await reg!.json()) as { client_id: string };
    await call("/admin/api/api-keys", authed({ method: "POST", body: JSON.stringify({ name: "key-d" }) }));

    // Usage joins on token_name (the credential id the request logger stamps).
    await storage.engine().query(
      `INSERT INTO mcp_request_log (token_name, agent_name, operation, status, created_at) VALUES
         ($1, 'caller', 'search', 'success', now()),
         ($1, 'caller', 'search', 'success', now() - interval '2 days'),
         ('key-d', 'caller', 'get_page', 'success', now())`,
      [client_id],
    );

    const r = await call("/admin/api/agents", authed());
    expect(r?.status).toBe(200);
    const body = (await r!.json()) as { count: number; agents: AgentRow[] };
    const oauth = body.agents.find((a) => a.auth_type === "oauth" && a.id === client_id)!;
    const key = body.agents.find((a) => a.auth_type === "api_key" && a.name === "key-d")!;
    expect(oauth.status).toBe("active");
    expect(oauth.token_ttl).toBe(60);
    expect(oauth.usage.total_requests).toBe(2);
    expect(oauth.usage.requests_today).toBe(1);
    expect(key.usage.total_requests).toBe(1);
    expect(key.usage.last_used_at).not.toBeNull();
  });
});

interface ConfigBody {
  mcp_url: string;
  name: string;
  sub: string;
  scope: { write: string | null; read: string[] };
  snippets: Record<string, string>;
}

describe("admin-api agent-config export", () => {
  const OLD_PUBLIC_URL = process.env.MEMEX_PUBLIC_URL;
  afterEach(() => {
    if (OLD_PUBLIC_URL === undefined) delete process.env.MEMEX_PUBLIC_URL;
    else process.env.MEMEX_PUBLIC_URL = OLD_PUBLIC_URL;
  });

  it("400s without a sub", async () => {
    const r = await call("/admin/api/agent-config", authed());
    expect(r?.status).toBe(400);
  });

  it("404s for a subject with no grant", async () => {
    const r = await call("/admin/api/agent-config?sub=ghost", authed());
    expect(r?.status).toBe(404);
  });

  it("returns copy-paste snippets with the public MCP URL + subject scope", async () => {
    delete process.env.MEMEX_PUBLIC_URL; // fall back to the request origin
    await call("/admin/api/sources", authed({ method: "POST", body: JSON.stringify({ id: "acme" }) }));
    await call("/admin/api/sources", authed({ method: "POST", body: JSON.stringify({ id: "shared" }) }));
    await call("/admin/api/grants", authed({ method: "POST", body: JSON.stringify({ sub: "agent-x", source: "acme", read: ["acme", "shared"] }) }));

    const r = await call("/admin/api/agent-config?sub=agent-x", authed());
    expect(r?.status).toBe(200);
    const body = (await r!.json()) as ConfigBody;

    expect(body.sub).toBe("agent-x");
    expect(body.mcp_url).toBe("http://localhost:8080/mcp"); // request origin + /mcp
    expect(body.scope.write).toBe("acme");
    expect(body.scope.read).toEqual(["acme", "shared"]);

    // Every common client is covered and carries the MCP URL, never a live token.
    for (const key of ["claude-code", "claude-desktop", "chatgpt", "cursor", "json"]) {
      expect(body.snippets[key]).toContain("http://localhost:8080/mcp");
      expect(body.snippets[key]).not.toContain("boot-secret");
    }
    expect(body.snippets["claude-code"]).toContain("claude mcp add memex");
    // The JSON-config clients emit valid JSON with an http mcpServers entry.
    const desktop = JSON.parse(body.snippets["claude-desktop"]!) as { mcpServers: Record<string, { type: string; url: string }> };
    const entry = desktop.mcpServers.memex!;
    expect(entry.type).toBe("http");
    expect(entry.url).toBe("http://localhost:8080/mcp");
  });

  it("prefers MEMEX_PUBLIC_URL over the request origin", async () => {
    process.env.MEMEX_PUBLIC_URL = "https://brain.example.test/";
    await call("/admin/api/sources", authed({ method: "POST", body: JSON.stringify({ id: "acme" }) }));
    await call("/admin/api/grants", authed({ method: "POST", body: JSON.stringify({ sub: "agent-z", source: "acme" }) }));

    const r = await call("/admin/api/agent-config?sub=agent-z", authed());
    const body = (await r!.json()) as ConfigBody;
    expect(body.mcp_url).toBe("https://brain.example.test/mcp"); // declared issuer wins, trailing slash trimmed
    expect(body.snippets["chatgpt"]).toContain("https://brain.example.test/mcp");
  });
});

describe("admin-api observability endpoints", () => {
  it("agents/spend reports today's spend + pending vs cap", async () => {
    const e = storage.engine();
    await e.query(`INSERT INTO oauth_clients (client_id, client_name, budget_usd_per_day) VALUES ('c1','Client One',1.00)`);
    await e.query(`INSERT INTO mcp_spend_log (client_id, operation, spend_cents) VALUES ('c1', 'think', 50)`);
    await e.query(`INSERT INTO mcp_spend_reservations (reservation_id, client_id, estimated_cents, model, provider, status, expires_at) VALUES ('r1', 'c1', 20, 'm', 'p', 'pending', now() + interval '1 hour')`);
    const r = await call("/admin/api/agents/spend", authed());
    const body = (await r!.json()) as { agents: Record<string, unknown>[] };
    const row = body.agents.find((a) => a.client_id === "c1")!;
    expect(Number(row.spent_cents_today)).toBe(50);
    expect(Number(row.pending_cents)).toBe(20);
    expect(Number(row.cap_usd_per_day)).toBe(1);
  });

  it("requests filters by operation and returns redacted params", async () => {
    const e = storage.engine();
    await e.query(`INSERT INTO mcp_request_log (operation, status, params) VALUES ('search','success','{"q":"hi"}'::jsonb)`);
    await e.query(`INSERT INTO mcp_request_log (operation, status) VALUES ('page_put','success')`);
    const r = await call("/admin/api/requests?operation=search", authed());
    const body = (await r!.json()) as { rows: Record<string, unknown>[]; total: number };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]?.operation).toBe("search");
    expect(body.rows[0]?.params).toBeTruthy();
    expect(body.total).toBe(1);
  });

  it("stats + health-indicators return auth rollups", async () => {
    const e = storage.engine();
    await e.query(`INSERT INTO oauth_clients (client_id, client_name) VALUES ('c2','C2')`);
    await e.query(`INSERT INTO mcp_request_log (operation, status) VALUES ('x','error')`);
    const stats = (await (await call("/admin/api/stats", authed()))!.json()) as Record<string, number>;
    expect(stats.connected_agents).toBeGreaterThanOrEqual(1);
    expect(stats.requests_today).toBeGreaterThanOrEqual(1);
    const hi = (await (await call("/admin/api/health-indicators", authed()))!.json()) as Record<string, number>;
    expect(hi.error_rate_24h).toBeGreaterThan(0);
  });
});
