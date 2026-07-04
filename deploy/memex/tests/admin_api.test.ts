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
