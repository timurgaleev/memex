/**
 * The admin surface reads its cookies and the `/authorize` approval parameter
 * under both the current `memrain_` names and the pre-rename `memex_` ones,
 * writes only the current names, and expires the pre-rename session cookie.
 */
import { describe, expect, it } from "bun:test";
import { createAdminAuth } from "../src/http/admin.ts";

const BOOT = "boot-secret-token";
const AUTHORIZE = "/authorize?client_id=cid&redirect_uri=https%3A%2F%2Fclient.example%2Fcb&code_challenge=ch&state=st";

function req(path: string, init?: RequestInit): Request {
  return new Request(`http://localhost:8080${path}`, init);
}

async function sessionId(a: ReturnType<typeof createAdminAuth>): Promise<string> {
  const ok = await a.handleAuthRoute(
    req("/admin/login", { method: "POST", body: JSON.stringify({ token: BOOT }) }),
    new URL("http://localhost:8080/admin/login"),
  );
  const cookie = ok!.headers.getSetCookie().find((c) => /^memrain_admin=[0-9a-f]/.test(c))!;
  return cookie.split(";")[0]!.split("=")[1]!;
}

async function approvalNonce(a: ReturnType<typeof createAdminAuth>, session: string): Promise<string> {
  const park = `/admin/login?return_to=${encodeURIComponent(AUTHORIZE)}`;
  const parked = await a.handleAuthRoute(req(park), new URL(`http://localhost:8080${park}`));
  const parkCookie = parked!.headers.getSetCookie().find((c) => c.startsWith("memrain_return_to="))!.split(";")[0]!;
  const cookie = `memrain_admin=${session}; ${parkCookie}`;
  const pending = await a.handleAuthRoute(
    req("/admin/api/pending-resume", { headers: { cookie } }),
    new URL("http://localhost:8080/admin/api/pending-resume"),
  );
  const { handle } = (await pending!.json()) as { handle: string };
  const approved = await a.handleAuthRoute(
    req("/admin/api/approve-resume", { method: "POST", headers: { cookie }, body: JSON.stringify({ handle }) }),
    new URL("http://localhost:8080/admin/api/approve-resume"),
  );
  const { redirect_to } = (await approved!.json()) as { redirect_to: string };
  return new URL(redirect_to, "http://x").searchParams.get("memrain_approval")!;
}

describe("what the admin surface writes", () => {
  it("sign-in writes only the current session cookie and expires the legacy one at / and /admin", async () => {
    const a = createAdminAuth({ bootstrapToken: BOOT });
    const res = await a.handleAuthRoute(
      req("/admin/login", { method: "POST", body: JSON.stringify({ token: BOOT }) }),
      new URL("http://localhost:8080/admin/login"),
    );
    const set = res!.headers.getSetCookie();
    const live = set.filter((c) => /^[a-z_]+=[0-9a-f]/.test(c));
    expect(live).toHaveLength(1);
    expect(live[0]).toStartWith("memrain_admin=");
    expect(live[0]).toContain("Path=/;");
    const legacy = set.filter((c) => c.startsWith("memex_admin="));
    expect(legacy.map((c) => c.split("; ").find((x) => x.startsWith("Path=")))).toEqual(["Path=/", "Path=/admin"]);
    for (const c of legacy) {
      expect(c).toStartWith("memex_admin=;");
      expect(c).toContain("Max-Age=0");
    }
  });

  it("a magic-link sign-in does the same", async () => {
    const a = createAdminAuth({ bootstrapToken: BOOT });
    const minted = await a.handleAuthRoute(
      req("/admin/api/issue-magic-link", { method: "POST", headers: { authorization: `Bearer ${BOOT}` } }),
      new URL("http://localhost:8080/admin/api/issue-magic-link"),
    );
    const path = new URL(((await minted!.json()) as { url: string }).url).pathname;
    const res = await a.handleAuthRoute(req(path), new URL(`http://localhost:8080${path}`));
    expect(res!.status).toBe(302);
    const set = res!.headers.getSetCookie();
    expect(set.filter((c) => /^[a-z_]+=[0-9a-f]/.test(c)).map((c) => c.split("=")[0])).toEqual(["memrain_admin"]);
    expect(set.filter((c) => c.startsWith("memex_admin=;") && c.includes("Max-Age=0"))).toHaveLength(2);
  });

  it("parks a sign-in resume and hands out an approval only under the current names", async () => {
    const a = createAdminAuth({ bootstrapToken: BOOT });
    const park = `/admin/login?return_to=${encodeURIComponent(AUTHORIZE)}`;
    const parked = await a.handleAuthRoute(req(park), new URL(`http://localhost:8080${park}`));
    const set = parked!.headers.getSetCookie();
    expect(set).toHaveLength(1);
    expect(set[0]).toStartWith("memrain_return_to=");
    const id = await sessionId(a);
    const nonce = await approvalNonce(a, id);
    expect(nonce).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("admin session cookie", () => {
  it("honours a session under the legacy and the current name, and nothing else", async () => {
    const a = createAdminAuth({ bootstrapToken: BOOT });
    const id = await sessionId(a);
    expect(a.requireAdmin(req("/admin/api/x", { headers: { cookie: `memex_admin=${id}` } }))).toBe(true);
    expect(a.requireAdmin(req("/admin/api/x", { headers: { cookie: `memrain_admin=${id}` } }))).toBe(true);
    expect(a.requireAdmin(req("/admin/api/x", { headers: { cookie: `other_admin=${id}` } }))).toBe(false);
    expect(a.requireAdmin(req("/admin/api/x", { headers: { cookie: `memrain_admin=${"0".repeat(64)}` } }))).toBe(false);
  });

  it("a dead value under one name does not shadow a live one under the other", async () => {
    const a = createAdminAuth({ bootstrapToken: BOOT });
    const id = await sessionId(a);
    const dead = "f".repeat(64);
    expect(a.requireAdmin(req("/x", { headers: { cookie: `memrain_admin=${dead}; memex_admin=${id}` } }))).toBe(true);
    expect(a.requireAdmin(req("/x", { headers: { cookie: `memex_admin=${dead}; memrain_admin=${id}` } }))).toBe(true);
  });
});

describe("sign-in resume cookie", () => {
  it("reads a parked request under the current name and clears it under that name", async () => {
    const a = createAdminAuth({ bootstrapToken: BOOT });
    const id = await sessionId(a);
    const cookie = `memex_admin=${id}; memrain_return_to=${encodeURIComponent(AUTHORIZE)}`;
    const pending = await a.handleAuthRoute(
      req("/admin/api/pending-resume", { headers: { cookie } }),
      new URL("http://localhost:8080/admin/api/pending-resume"),
    );
    expect(((await pending!.json()) as { redirect_to: string }).redirect_to).toBe(AUTHORIZE);

    const dismissed = await a.handleAuthRoute(
      req("/admin/api/dismiss-resume", { method: "POST", headers: { cookie } }),
      new URL("http://localhost:8080/admin/api/dismiss-resume"),
    );
    const cleared = dismissed!.headers.getSetCookie();
    expect(cleared).toHaveLength(1);
    expect(cleared[0]).toStartWith("memrain_return_to=;");
    expect(cleared[0]).toContain("Max-Age=0");
  });

  it("a legacy-only request gets exactly today's legacy clear", async () => {
    const a = createAdminAuth({ bootstrapToken: BOOT });
    const id = await sessionId(a);
    const cookie = `memex_admin=${id}; memex_return_to=${encodeURIComponent(AUTHORIZE)}`;
    const dismissed = await a.handleAuthRoute(
      req("/admin/api/dismiss-resume", { method: "POST", headers: { cookie } }),
      new URL("http://localhost:8080/admin/api/dismiss-resume"),
    );
    const cleared = dismissed!.headers.getSetCookie();
    expect(cleared).toHaveLength(1);
    expect(cleared[0]).toStartWith("memex_return_to=;");
  });
});

describe("/authorize approval parameter", () => {
  for (const param of ["memex_approval", "memrain_approval"]) {
    it(`consumes a nonce sent as ${param}, once`, async () => {
      const a = createAdminAuth({ bootstrapToken: BOOT });
      const id = await sessionId(a);
      const nonce = await approvalNonce(a, id);
      const target = `${AUTHORIZE}&${param}=${nonce}`;
      expect(a.consumeAuthorizeApproval(req(target))).toBe(true);
      expect(a.consumeAuthorizeApproval(req(target))).toBe(false);
    });
  }

  it("does not accept the nonce under an unrelated parameter name", async () => {
    const a = createAdminAuth({ bootstrapToken: BOOT });
    const id = await sessionId(a);
    const nonce = await approvalNonce(a, id);
    expect(a.consumeAuthorizeApproval(req(`${AUTHORIZE}&approval=${nonce}`))).toBe(false);
  });
});
