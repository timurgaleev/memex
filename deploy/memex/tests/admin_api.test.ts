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
});
