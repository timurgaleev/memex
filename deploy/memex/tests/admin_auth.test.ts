/**
 * Admin auth core (increment A1) — bootstrap login, magic-link mint + single-use
 * redemption, the session cookie, requireAdmin, and sign-out-everywhere.
 */
import { describe, expect, it } from "bun:test";
import { createAdminAuth } from "../src/http/admin.ts";

const BOOT = "boot-secret-token";

function req(path: string, init?: RequestInit): Request {
  return new Request(`http://localhost:8080${path}`, init);
}
function cookieFrom(res: Response): string {
  const sc = res.headers.get("Set-Cookie") ?? "";
  return sc.split(";")[0] ?? ""; // "memex_admin=<id>"
}

describe("admin auth — bootstrap login", () => {
  it("rejects a wrong token, accepts the bootstrap token + sets a cookie", async () => {
    const a = createAdminAuth({ bootstrapToken: BOOT });
    const u = new URL("http://localhost:8080/admin/login");

    const bad = await a.handleAuthRoute(req("/admin/login", { method: "POST", body: JSON.stringify({ token: "nope" }) }), u);
    expect(bad?.status).toBe(401);

    const ok = await a.handleAuthRoute(req("/admin/login", { method: "POST", body: JSON.stringify({ token: BOOT }) }), u);
    expect(ok?.status).toBe(200);
    const cookie = cookieFrom(ok!);
    expect(cookie).toContain("memex_admin=");
    expect(ok!.headers.get("Set-Cookie")).toContain("HttpOnly");
    expect(ok!.headers.get("Set-Cookie")).toContain("SameSite=Strict");

    // The cookie authorizes requireAdmin.
    expect(a.requireAdmin(req("/admin/api/x", { headers: { cookie } }))).toBe(true);
    expect(a.requireAdmin(req("/admin/api/x"))).toBe(false);
  });
});

describe("admin auth — magic link", () => {
  it("mints with the bootstrap bearer, redeems once, then is dead", async () => {
    const a = createAdminAuth({ bootstrapToken: BOOT });

    // Mint requires the bootstrap bearer.
    const noAuth = await a.handleAuthRoute(
      req("/admin/api/issue-magic-link", { method: "POST" }),
      new URL("http://localhost:8080/admin/api/issue-magic-link"),
    );
    expect(noAuth?.status).toBe(401);

    const mint = await a.handleAuthRoute(
      req("/admin/api/issue-magic-link", { method: "POST", headers: { authorization: `Bearer ${BOOT}` } }),
      new URL("http://localhost:8080/admin/api/issue-magic-link"),
    );
    expect(mint?.status).toBe(200);
    const { url } = (await mint!.json()) as { url: string };
    const noncePath = new URL(url).pathname; // /admin/auth/<nonce>

    // First redemption → 302 + cookie.
    const redeem = await a.handleAuthRoute(req(noncePath), new URL(url));
    expect(redeem?.status).toBe(302);
    expect(redeem!.headers.get("Location")).toBe("/admin/");
    expect(a.requireAdmin(req("/x", { headers: { cookie: cookieFrom(redeem!) } }))).toBe(true);

    // Second redemption of the same nonce → 401 (single-use).
    const again = await a.handleAuthRoute(req(noncePath), new URL(url));
    expect(again?.status).toBe(401);
  });
});

describe("admin auth — sign-out-everywhere", () => {
  it("requires a session and then revokes all", async () => {
    const a = createAdminAuth({ bootstrapToken: BOOT });
    const login = await a.handleAuthRoute(
      req("/admin/login", { method: "POST", body: JSON.stringify({ token: BOOT }) }),
      new URL("http://localhost:8080/admin/login"),
    );
    const cookie = cookieFrom(login!);

    const noSession = await a.handleAuthRoute(
      req("/admin/api/sign-out-everywhere", { method: "POST" }),
      new URL("http://localhost:8080/admin/api/sign-out-everywhere"),
    );
    expect(noSession?.status).toBe(401);

    const out = await a.handleAuthRoute(
      req("/admin/api/sign-out-everywhere", { method: "POST", headers: { cookie } }),
      new URL("http://localhost:8080/admin/api/sign-out-everywhere"),
    );
    expect(out?.status).toBe(200);
    // The cookie is now dead.
    expect(a.requireAdmin(req("/x", { headers: { cookie } }))).toBe(false);
  });
});

describe("admin auth — non-auth path", () => {
  it("returns null so a later dispatcher can handle it", async () => {
    const a = createAdminAuth({ bootstrapToken: BOOT });
    const r = await a.handleAuthRoute(req("/admin/api/agents"), new URL("http://localhost:8080/admin/api/agents"));
    expect(r).toBeNull();
  });
});
