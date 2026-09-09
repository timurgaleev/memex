/**
 * One connector, many tenants — the identity half.
 *
 * A Team-plan connector has exactly one client_id and every member authorises
 * against it, so the tenant cannot come from the client row. An enrollment-mode
 * client asks the person for a one-time code the operator issued for her
 * source; the grant is bound to that source (mig 101) and the refresh token
 * carries it forward. These tests drive the HTTP handler the way a browser
 * would: GET renders the form and mints nothing, POST with a live code mints a
 * grant-bound authorization code, and every way a code can be bad looks
 * identical from the outside.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { OAuthProvider, type OAuthClientInfo } from "../src/core/oauth-provider.ts";
import { registerSource } from "../src/core/sources.ts";
import { handleAuthorizeRoute } from "../src/http/oauth-endpoints.ts";

const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

let tmp: string;
let storage: Storage;
let provider: OAuthProvider;
let teamClient: OAuthClientInfo;
let teamSecret: string;
let plainClient: OAuthClientInfo;

function authorizeUrl(client: OAuthClientInfo, state = "s1"): string {
  const q = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: REDIRECT,
    response_type: "code",
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    state,
  });
  return `http://brain.example.test/authorize?${q}`;
}

function get(client: OAuthClientInfo, gate?: (r: Request) => boolean) {
  return handleAuthorizeRoute(new Request(authorizeUrl(client)), provider, gate);
}

function post(client: OAuthClientInfo, code: string, gate?: (r: Request) => boolean) {
  return handleAuthorizeRoute(
    new Request(authorizeUrl(client), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ enrollment_code: code }).toString(),
    }),
    provider,
    gate,
  );
}

async function codeCount(): Promise<number> {
  const r = await storage.engine().query<{ n: number }>(
    "SELECT COUNT(*)::int AS n FROM oauth_codes",
  );
  return r.rows[0]?.n ?? 0;
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-enroll-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  const e = storage.engine();
  await registerSource(e, { id: "tina", kind: "other", pathPrefix: "tenant:tina" });
  await registerSource(e, { id: "rachel", kind: "other", pathPrefix: "tenant:rachel" });
  provider = new OAuthProvider({ engine: storage.raw() });

  const team = await provider.registerClientManual(
    "team-connector",
    ["authorization_code", "refresh_token"],
    "read write",
    [REDIRECT],
    "default",
    undefined,
    undefined,
    undefined,
    "enrollment",
  );
  teamSecret = team.clientSecret!;
  teamClient = (await provider.getClient(team.clientId))!;

  const plain = await provider.registerClientManual(
    "plain-connector",
    ["authorization_code", "refresh_token"],
    "read write",
    [REDIRECT],
    "default",
  );
  plainClient = (await provider.getClient(plain.clientId))!;
}, 30_000);

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
}, 30_000);

describe("enrollment-mode /authorize", () => {
  it("GET renders the code form and mints nothing", async () => {
    const before = await codeCount();
    const res = await get(teamClient);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/html");
    const html = await res.text();
    expect(html).toContain('name="enrollment_code"');
    // Nothing about the brain leaks through the page. (The client_id does
    // appear — in the form action — but the browser already has it in the
    // address bar; it is the client's own request echoed back.)
    expect(html).not.toContain("tina");
    expect(await codeCount()).toBe(before);
  });

  it("the form ignores the operator-login gate — the code is the login", async () => {
    const res = await get(teamClient, () => false);
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });

  it("POST with a live code binds the grant to the code's source", async () => {
    const issued = await provider.issueEnrollment({ sourceId: "tina", label: "tina" });
    const res = await post(teamClient, issued.code);
    expect(res.status).toBe(303);
    const loc = res.headers.get("location") ?? "";
    expect(loc.startsWith(`${REDIRECT}?`)).toBe(true);
    const code = new URL(loc).searchParams.get("code")!;
    expect(code).toBeTruthy();
    expect(new URL(loc).searchParams.get("state")).toBe("s1");

    const tokens = await provider.exchangeAuthorizationCode(
      { ...teamClient, client_secret: teamSecret },
      code,
      undefined,
      REDIRECT,
    );
    const info = await provider.verifyAccessToken(tokens.access_token);
    expect(info.sourceId).toBe("tina");
    expect(info.allowedSources).toEqual(["tina"]);

    // The refresh token carries the grant forward — no second code needed.
    const rotated = await provider.exchangeRefreshToken(
      { ...teamClient, client_secret: teamSecret },
      tokens.refresh_token!,
    );
    const again = await provider.verifyAccessToken(rotated.access_token);
    expect(again.sourceId).toBe("tina");

    // Audit trail: the enrollment knows which authorization code it produced.
    const rows = await provider.listEnrollments();
    const mine = rows.find((r) => r.id === issued.id)!;
    expect(mine.used_at).not.toBeNull();
  });

  it("two people on the SAME client land in different sources", async () => {
    const a = await provider.issueEnrollment({ sourceId: "tina" });
    const b = await provider.issueEnrollment({ sourceId: "rachel" });
    const ra = await post(teamClient, a.code);
    const rb = await post(teamClient, b.code);
    const ca = new URL(ra.headers.get("location")!).searchParams.get("code")!;
    const cb = new URL(rb.headers.get("location")!).searchParams.get("code")!;
    const c = { ...teamClient, client_secret: teamSecret };
    const ta = await provider.exchangeAuthorizationCode(c, ca, undefined, REDIRECT);
    const tb = await provider.exchangeAuthorizationCode(c, cb, undefined, REDIRECT);
    expect((await provider.verifyAccessToken(ta.access_token)).sourceId).toBe("tina");
    expect((await provider.verifyAccessToken(tb.access_token)).sourceId).toBe("rachel");
  });

  it("a code works exactly once", async () => {
    const issued = await provider.issueEnrollment({ sourceId: "rachel" });
    expect((await post(teamClient, issued.code)).status).toBe(303);
    const before = await codeCount();
    const second = await post(teamClient, issued.code);
    expect(second.status).toBe(400);
    expect(await second.text()).toContain("not accepted");
    expect(await codeCount()).toBe(before);
  });

  it("wrong, expired, revoked and other-client codes are indistinguishable", async () => {
    const before = await codeCount();

    const wrong = await post(teamClient, "memex_en_" + "0".repeat(64));

    const expired = await provider.issueEnrollment({ sourceId: "tina", ttlSeconds: 1 });
    await storage.engine().query(
      "UPDATE oauth_enrollments SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1",
      [expired.id],
    );
    const exp = await post(teamClient, expired.code);

    const revoked = await provider.issueEnrollment({ sourceId: "tina" });
    expect(await provider.revokeEnrollment(revoked.id)).toBe(true);
    const rev = await post(teamClient, revoked.code);

    const other = await provider.registerClientManual(
      "other-team", ["authorization_code"], "read write", [REDIRECT], "default",
      undefined, undefined, undefined, "enrollment",
    );
    const pinned = await provider.issueEnrollment({ sourceId: "tina", clientId: other.clientId });
    const oth = await post(teamClient, pinned.code);

    const bodies = await Promise.all([wrong, exp, rev, oth].map(async (r) => [r.status, await r.text()] as const));
    for (const [status, body] of bodies) {
      expect(status).toBe(400);
      expect(body).toContain("not accepted");
      expect(body).not.toMatch(/expired|revoked|used|another client/i);
    }
    expect(await codeCount()).toBe(before);
  });

  it("issuing for an unknown source or a client-mode client is refused up front", async () => {
    await expect(provider.issueEnrollment({ sourceId: "nobody" })).rejects.toThrow(/Unknown source/);
    await expect(
      provider.issueEnrollment({ sourceId: "tina", clientId: plainClient.client_id }),
    ).rejects.toThrow(/enrollment mode/);
  });
});

describe("client-mode /authorize is untouched", () => {
  it("still redirects straight back with a code", async () => {
    const res = await get(plainClient);
    expect(res.status).toBe(302);
    expect(res.headers.get("location") ?? "").toContain(`${REDIRECT}?code=`);
  });

  it("still honours the operator-login gate", async () => {
    const res = await get(plainClient, () => false);
    expect(res.status).toBe(302);
    expect(res.headers.get("location") ?? "").toContain("/admin/login");
  });

  it("does not accept POST", async () => {
    const res = await post(plainClient, "anything");
    expect(res.status).toBe(405);
  });

  it("a client-mode grant still inherits the client's source", async () => {
    const res = await get(plainClient);
    const code = new URL(res.headers.get("location")!).searchParams.get("code")!;
    const tokens = await provider.exchangeAuthorizationCode(plainClient, code, undefined, REDIRECT);
    expect((await provider.verifyAccessToken(tokens.access_token)).sourceId).toBe("default");
  });
});
