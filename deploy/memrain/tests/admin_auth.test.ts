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
    // Path=/ — /authorize is outside /admin and asks requireAdmin whether an
    // operator is signed in; a cookie scoped to /admin never reaches it.
    expect(ok!.headers.get("Set-Cookie")).toContain("Path=/;");

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


describe("admin auth — login throttle keying", () => {
  it("a rotated X-Forwarded-For cannot mint a fresh brute-force bucket", async () => {
    const saved = process.env["MEMEX_HTTP_TRUST_PROXY"];
    delete process.env["MEMEX_HTTP_TRUST_PROXY"];
    try {
      const a = createAdminAuth({ bootstrapToken: BOOT });
      const u = new URL("http://localhost:8080/admin/login");
      const attempt = (xff: string) =>
        a.handleAuthRoute(
          req("/admin/login", {
            method: "POST",
            headers: { "X-Forwarded-For": xff },
            body: JSON.stringify({ token: "nope" }),
          }),
          u,
        );
      // The limiter allows 10 attempts per key. With the trust flag off, an
      // unattributable caller cannot buy extra attempts by rotating XFF.
      for (let i = 0; i < 10; i++) {
        expect((await attempt(`10.0.0.${i}`))?.status).toBe(401);
      }
      expect((await attempt("10.0.0.99"))?.status).toBe(429);
    } finally {
      if (saved === undefined) delete process.env["MEMEX_HTTP_TRUST_PROXY"];
      else process.env["MEMEX_HTTP_TRUST_PROXY"] = saved;
    }
  });
});

describe("admin auth — the pre-Path=/ cookie cannot lock the operator out", () => {
  it("expires the /admin-scoped cookie on login and accepts the live one behind it", async () => {
    const a = createAdminAuth({ bootstrapToken: BOOT });
    const login = await a.handleAuthRoute(
      req("/admin/login", { method: "POST", body: JSON.stringify({ token: BOOT }) }),
      new URL("http://localhost:8080/admin/login"),
    );
    const set = login!.headers.getSetCookie();
    expect(set.some((c) => c.includes("Path=/;"))).toBe(true);
    // The old scope is expired in the same response.
    expect(set.some((c) => c.includes("Path=/admin") && c.includes("Max-Age=0"))).toBe(true);

    // A browser that still holds the dead one sends it FIRST (longer path wins,
    // RFC 6265 §5.4). The live session behind it must still authorize.
    const live = set.find((c) => c.startsWith("memex_admin=") && c.includes("Path=/;"))!.split(";")[0]!;
    expect(a.requireAdmin(req("/admin/api/x", { headers: { cookie: `memex_admin=dead-session; ${live}` } }))).toBe(true);
    expect(a.requireAdmin(req("/admin/api/x", { headers: { cookie: "memex_admin=dead-session" } }))).toBe(false);
  });
});

describe("admin auth — an OAuth connect parked for sign-in", () => {
  const AUTHORIZE = "/authorize?client_id=cid&redirect_uri=https%3A%2F%2Fclient.example%2Fcb&scope=read";

  function loginGet(a: ReturnType<typeof createAdminAuth>, returnTo: string) {
    const path = `/admin/login?return_to=${encodeURIComponent(returnTo)}`;
    return a.handleAuthRoute(req(path), new URL(`http://localhost:8080${path}`));
  }
  function returnCookie(res: Response): string | undefined {
    return res.headers.getSetCookie().find((c) => c.startsWith("memex_return_to="));
  }
  function pendingResume(a: ReturnType<typeof createAdminAuth>, cookie?: string) {
    return a.handleAuthRoute(
      req("/admin/api/pending-resume", cookie ? { headers: { cookie } } : undefined),
      new URL("http://localhost:8080/admin/api/pending-resume"),
    );
  }
  async function session(a: ReturnType<typeof createAdminAuth>): Promise<string> {
    const login = await a.handleAuthRoute(
      req("/admin/login", { method: "POST", body: JSON.stringify({ token: BOOT }) }),
      new URL("http://localhost:8080/admin/login"),
    );
    return login!.headers.getSetCookie().find((c) => c.startsWith("memex_admin="))!.split(";")[0]!;
  }

  it("parks the authorize URL without following it, and describes it for confirmation", async () => {
    const a = createAdminAuth({
      bootstrapToken: BOOT,
      describeClient: async (id) => (id === "cid" ? { client_name: "timur-chatgpt" } : null),
    });

    const parked = await loginGet(a, `http://localhost:8080${AUTHORIZE}`);
    expect(parked?.status).toBe(302);
    expect(parked!.headers.get("Location")).toBe("/admin/");
    const setCookie = returnCookie(parked!)!;
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    const cookie = setCookie.split(";")[0]!;

    // Signing in must not navigate anywhere by itself.
    const login = await a.handleAuthRoute(
      req("/admin/login", { method: "POST", headers: { cookie }, body: JSON.stringify({ token: BOOT }) }),
      new URL("http://localhost:8080/admin/login"),
    );
    expect(await login!.json()).toEqual({ status: "authenticated" });
    const sess = login!.headers.getSetCookie().find((c) => c.startsWith("memex_admin="))!.split(";")[0]!;

    // The parked request survives the login and is described, not followed.
    const pending = await pendingResume(a, `${sess}; ${cookie}`);
    expect(await pending!.json()).toEqual({
      handle: expect.any(String),
      redirect_to: AUTHORIZE,
      client_id: "cid",
      client_name: "timur-chatgpt",
      redirect_uri: "https://client.example/cb",
      resource: null,
      scope: "read",
    });
  });

  it("never auto-follows a magic-link sign-in", async () => {
    const a = createAdminAuth({ bootstrapToken: BOOT });
    const parked = await loginGet(a, `http://localhost:8080${AUTHORIZE}`);
    const cookie = returnCookie(parked!)!.split(";")[0]!;
    const mint = await a.handleAuthRoute(
      req("/admin/api/issue-magic-link", { method: "POST", headers: { authorization: `Bearer ${BOOT}` } }),
      new URL("http://localhost:8080/admin/api/issue-magic-link"),
    );
    const { url } = (await mint!.json()) as { url: string };
    const redeem = await a.handleAuthRoute(req(new URL(url).pathname, { headers: { cookie } }), new URL(url));
    expect(redeem?.status).toBe(302);
    expect(redeem!.headers.get("Location")).toBe("/admin/");
  });

  it("refuses any target that is not this server's /authorize", async () => {
    const a = createAdminAuth({ bootstrapToken: BOOT });
    for (const evil of [
      "https://evil.example/x",
      "//evil.example/x",
      "/admin/api/full-stats",
      "javascript:alert(1)",
    ]) {
      expect(await loginGet(a, evil)).toBeNull();
    }
    // A host-relative //evil.example/authorize keeps only the path, so any later
    // navigation stays on this origin.
    const stripped = await loginGet(a, "//evil.example/authorize?client_id=cid");
    expect(returnCookie(stripped!)).toContain("memex_return_to=%2Fauthorize%3Fclient_id%3Dcid");
  });

  it("tells a session with nothing parked that there is nothing, and refuses without one", async () => {
    const a = createAdminAuth({ bootstrapToken: BOOT });
    expect((await pendingResume(a))?.status).toBe(401);
    expect((await pendingResume(a, "memex_return_to=%2Fauthorize%3Fclient_id%3Dcid"))?.status).toBe(401);
    const sess = await session(a);
    expect(await (await pendingResume(a, sess))!.json()).toEqual({ redirect_to: null });
  });

  it("leaves the plain sign-in paths untouched", async () => {
    const a = createAdminAuth({ bootstrapToken: BOOT });
    expect(await a.handleAuthRoute(req("/admin/login"), new URL("http://localhost:8080/admin/login"))).toBeNull();
    const ok = await a.handleAuthRoute(
      req("/admin/login", { method: "POST", body: JSON.stringify({ token: BOOT }) }),
      new URL("http://localhost:8080/admin/login"),
    );
    expect(await ok!.json()).toEqual({ status: "authenticated" });
    expect(returnCookie(ok!)).toBeUndefined();
  });
});

describe("admin auth — the approval is the consent, not the session", () => {
  const AUTHORIZE = "/authorize?client_id=cid&redirect_uri=https%3A%2F%2Fclient.example%2Fcb&code_challenge=ch&state=st";

  async function parkedSession(a: ReturnType<typeof createAdminAuth>) {
    const path = `/admin/login?return_to=${encodeURIComponent(AUTHORIZE)}`;
    const parked = await a.handleAuthRoute(req(path), new URL(`http://localhost:8080${path}`));
    const parkCookie = parked!.headers.getSetCookie()
      .find((c) => c.startsWith("memex_return_to="))!.split(";")[0]!;
    const login = await a.handleAuthRoute(
      req("/admin/login", { method: "POST", body: JSON.stringify({ token: BOOT }) }),
      new URL("http://localhost:8080/admin/login"),
    );
    const session = login!.headers.getSetCookie()
      .find((c) => c.startsWith("memex_admin="))!.split(";")[0]!;
    return { cookie: `${session}; ${parkCookie}`, session };
  }
  async function handleFor(a: ReturnType<typeof createAdminAuth>, cookie: string): Promise<string> {
    const pending = await a.handleAuthRoute(
      req("/admin/api/pending-resume", { headers: { cookie } }),
      new URL("http://localhost:8080/admin/api/pending-resume"),
    );
    return ((await pending!.json()) as { handle: string }).handle;
  }
  function approve(a: ReturnType<typeof createAdminAuth>, cookie: string, handle?: string, extra?: Record<string, string>) {
    return a.handleAuthRoute(
      req("/admin/api/approve-resume", {
        method: "POST",
        headers: { cookie, ...(extra ?? {}) },
        body: JSON.stringify({ handle }),
      }),
      new URL("http://localhost:8080/admin/api/approve-resume"),
    );
  }
  /** What server.ts asks of /authorize: a live session AND this request's approval. */
  function authorizeAllowed(a: ReturnType<typeof createAdminAuth>, target: string, session: string): boolean {
    const r = req(target, { headers: { cookie: session } });
    return a.requireAdmin(r) && a.consumeAuthorizeApproval(r);
  }

  it("mints a single-use approval bound to the parked request", async () => {
    const a = createAdminAuth({ bootstrapToken: BOOT });
    const { cookie, session } = await parkedSession(a);

    // No approval yet — a live session is not enough.
    expect(authorizeAllowed(a, AUTHORIZE, session)).toBe(false);

    const res = await approve(a, cookie, await handleFor(a, cookie));
    const { redirect_to } = (await res!.json()) as { redirect_to: string };
    expect(redirect_to).toContain("memex_approval=");
    expect(res!.headers.getSetCookie().find((c) => c.startsWith("memex_return_to="))).toContain("Max-Age=0");

    expect(authorizeAllowed(a, redirect_to, session)).toBe(true);
    // Single use.
    expect(authorizeAllowed(a, redirect_to, session)).toBe(false);
  });

  it("refuses an approval moved onto a different request", async () => {
    const a = createAdminAuth({ bootstrapToken: BOOT });
    const { cookie, session } = await parkedSession(a);
    const { redirect_to } = (await (await approve(a, cookie, await handleFor(a, cookie)))!.json()) as { redirect_to: string };
    const nonce = new URL(redirect_to, "http://x").searchParams.get("memex_approval")!;

    // Same nonce, attacker's client and callback.
    const moved = `/authorize?client_id=evil&redirect_uri=https%3A%2F%2Fevil.example%2Fcb&code_challenge=ch&state=st&memex_approval=${nonce}`;
    expect(authorizeAllowed(a, moved, session)).toBe(false);
    // And it is burnt, so the original cannot be completed with it either.
    expect(authorizeAllowed(a, redirect_to, session)).toBe(false);
  });

  it("dismissing drops the parked request, and approving needs one", async () => {
    const a = createAdminAuth({ bootstrapToken: BOOT });
    const { cookie, session } = await parkedSession(a);

    const dismissed = await a.handleAuthRoute(
      req("/admin/api/dismiss-resume", { method: "POST", headers: { cookie } }),
      new URL("http://localhost:8080/admin/api/dismiss-resume"),
    );
    expect(await dismissed!.json()).toEqual({ dismissed: true });
    expect(dismissed!.headers.getSetCookie().find((c) => c.startsWith("memex_return_to="))).toContain("Max-Age=0");

    // With nothing parked there is nothing to approve.
    const nothing = await approve(a, session, "whatever");
    expect(nothing?.status).toBe(404);
    // And both endpoints refuse an anonymous caller outright.
    expect((await approve(a, "memex_return_to=%2Fauthorize%3Fclient_id%3Dcid", "x"))?.status).toBe(401);
  });
});

describe("admin auth — approving only what was on screen", () => {
  const A = "/authorize?client_id=cid&redirect_uri=https%3A%2F%2Fclient.example%2Fcb&code_challenge=ch";
  const B = "/authorize?client_id=evil&redirect_uri=https%3A%2F%2Fevil.example%2Fcb&code_challenge=ch";

  function park(a: ReturnType<typeof createAdminAuth>, target: string) {
    const path = `/admin/login?return_to=${encodeURIComponent(target)}`;
    return a.handleAuthRoute(req(path), new URL(`http://localhost:8080${path}`));
  }
  async function setup(target: string) {
    const a = createAdminAuth({ bootstrapToken: BOOT });
    const parked = await park(a, target);
    const parkCookie = parked!.headers.getSetCookie()
      .find((c) => c.startsWith("memex_return_to="))!.split(";")[0]!;
    const login = await a.handleAuthRoute(
      req("/admin/login", { method: "POST", body: JSON.stringify({ token: BOOT }) }),
      new URL("http://localhost:8080/admin/login"),
    );
    const session = login!.headers.getSetCookie()
      .find((c) => c.startsWith("memex_admin="))!.split(";")[0]!;
    return { a, session, cookie: `${session}; ${parkCookie}` };
  }
  function pending(a: ReturnType<typeof createAdminAuth>, cookie: string) {
    return a.handleAuthRoute(
      req("/admin/api/pending-resume", { headers: { cookie } }),
      new URL("http://localhost:8080/admin/api/pending-resume"),
    );
  }
  function approveWith(a: ReturnType<typeof createAdminAuth>, cookie: string, handle: unknown, extra?: Record<string, string>) {
    return a.handleAuthRoute(
      req("/admin/api/approve-resume", {
        method: "POST",
        headers: { cookie, ...(extra ?? {}) },
        body: JSON.stringify({ handle }),
      }),
      new URL("http://localhost:8080/admin/api/approve-resume"),
    );
  }

  it("refuses a click meant for a request that has since been swapped", async () => {
    const { a, session } = await setup(A);
    // The panel rendered request A…
    const parkedA = (await park(a, A))!.headers.getSetCookie()
      .find((c) => c.startsWith("memex_return_to="))!.split(";")[0]!;
    const shownHandle = ((await (await pending(a, `${session}; ${parkedA}`))!.json()) as { handle: string }).handle;

    // …then something replaced the parked request with B before the click.
    const parkedB = (await park(a, B))!.headers.getSetCookie()
      .find((c) => c.startsWith("memex_return_to="))!.split(";")[0]!;
    const res = await approveWith(a, `${session}; ${parkedB}`, shownHandle);
    expect(res?.status).toBe(409);
    // The refusal must leave B pending: it asks the operator to review the
    // request that IS parked, so that request has to survive the refusal.
    expect(res!.headers.getSetCookie().some((c) => c.startsWith("memex_return_to="))).toBe(false);
    const still = (await (await pending(a, `${session}; ${parkedB}`))!.json()) as { client_id: string };
    expect(still.client_id).toBe("evil");
  });

  it("still describes a request whose client cannot be looked up", async () => {
    const a = createAdminAuth({
      bootstrapToken: BOOT,
      describeClient: async () => { throw new Error("db down"); },
    });
    const parked = await park(a, A);
    const parkCookie = parked!.headers.getSetCookie()
      .find((c) => c.startsWith("memex_return_to="))!.split(";")[0]!;
    const login = await a.handleAuthRoute(
      req("/admin/login", { method: "POST", body: JSON.stringify({ token: BOOT }) }),
      new URL("http://localhost:8080/admin/login"),
    );
    const sess = login!.headers.getSetCookie()
      .find((c) => c.startsWith("memex_admin="))!.split(";")[0]!;
    const shown = (await (await pending(a, `${sess}; ${parkCookie}`))!.json()) as {
      client_id: string; client_name: string | null;
    };
    // Degrades to the id rather than taking the consent panel down with it.
    expect(shown.client_id).toBe("cid");
    expect(shown.client_name).toBeNull();
  });

  it("binds the resource indicator, which decides the token's audience", async () => {
    const withResource = `${A}&resource=https%3A%2F%2Fapi.example%2F`;
    const { a, session, cookie } = await setup(withResource);
    const shown = (await (await pending(a, cookie))!.json()) as { handle: string; resource: string };
    expect(shown.resource).toBe("https://api.example/");
    const { redirect_to } = (await (await approveWith(a, cookie, shown.handle))!.json()) as { redirect_to: string };
    const nonce = new URL(redirect_to, "http://x").searchParams.get("memex_approval")!;

    // Same everything, different audience → refused.
    const swapped = `${A}&resource=https%3A%2F%2Fevil.example%2F&memex_approval=${nonce}`;
    const r = req(swapped, { headers: { cookie: session } });
    expect(a.requireAdmin(r) && a.consumeAuthorizeApproval(r)).toBe(false);
  });

  it("refuses a browser POST that did not come from this origin", async () => {
    const { a, cookie } = await setup(A);
    const shown = (await (await pending(a, cookie))!.json()) as { handle: string };
    // A form POST from a sibling subdomain is same-SITE, so the Strict session
    // cookie rides along — fetch metadata is what tells them apart.
    expect((await approveWith(a, cookie, shown.handle, { "sec-fetch-site": "same-site" }))?.status).toBe(403);
    expect((await approveWith(a, cookie, shown.handle, { origin: "https://evil.example" }))?.status).toBe(403);
    // The legitimate same-origin click still works.
    expect((await approveWith(a, cookie, shown.handle, { "sec-fetch-site": "same-origin" }))?.status).toBe(200);
  });
});
