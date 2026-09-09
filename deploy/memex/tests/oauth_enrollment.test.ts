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

/** POST carrying the headers a cross-origin auto-submitting form would send. */
function postCrossOrigin(client: OAuthClientInfo, code: string, headers: Record<string, string>) {
  return handleAuthorizeRoute(
    new Request(authorizeUrl(client), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams({ enrollment_code: code }).toString(),
    }),
    provider,
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

describe("the enrollment POST is not forgeable from another site", () => {
  // Tenant fixation: an attacker page auto-submits HIS code from HER browser,
  // and her connector binds to his source — every note she writes lands in his
  // tenant. A cross-origin form POST needs no preflight, so CORS does not stop
  // it, and `state` is the client's business, not ours.
  it("refuses a cross-site POST and does not burn the code", async () => {
    const issued = await provider.issueEnrollment({ sourceId: "tina" });
    const before = await codeCount();

    const forgeries: Record<string, string>[] = [
      { "Sec-Fetch-Site": "cross-site" },
      { Origin: "https://evil.example" },
      { "Sec-Fetch-Site": "same-site", Origin: "https://evil.example" },
    ];
    for (const headers of forgeries) {
      const res = await postCrossOrigin(teamClient, issued.code, headers);
      expect(res.status).toBe(403);
    }
    expect(await codeCount()).toBe(before);

    // Still usable afterwards — a refused forgery must not cost the person
    // her one code.
    expect((await post(teamClient, issued.code)).status).toBe(303);
  });

  it("accepts the browser's own same-origin submission", async () => {
    const issued = await provider.issueEnrollment({ sourceId: "rachel" });
    const res = await postCrossOrigin(teamClient, issued.code, {
      "Sec-Fetch-Site": "same-origin",
      Origin: "http://brain.example.test",
    });
    expect(res.status).toBe(303);
  });
});

describe("a code is not lost when minting fails", () => {
  it("is handed back if the grant cannot be issued", async () => {
    const issued = await provider.issueEnrollment({ sourceId: "tina" });
    // Claim it the way the handler does, then fail to mint.
    const grant = await provider.claimEnrollment(issued.code, teamClient.client_id);
    expect(grant).toBeTruthy();
    expect((await provider.listEnrollments()).find((r) => r.id === issued.id)!.used_at).not.toBeNull();

    expect(await provider.releaseEnrollment(issued.code)).toBe(true);
    expect((await provider.listEnrollments()).find((r) => r.id === issued.id)!.used_at).toBeNull();
    // And it works for real afterwards.
    expect((await post(teamClient, issued.code)).status).toBe(303);
  });

  it("a code whose grant WAS issued stays spent", async () => {
    const issued = await provider.issueEnrollment({ sourceId: "tina" });
    expect((await post(teamClient, issued.code)).status).toBe(303);
    // linkEnrollmentToCode stamped used_code_hash, so the release is refused.
    expect(await provider.releaseEnrollment(issued.code)).toBe(false);
    expect((await post(teamClient, issued.code)).status).toBe(400);
  });
});

describe("operator controls", () => {
  it("a revoked connector cannot be enrolled into", async () => {
    const doomed = await provider.registerClientManual(
      "doomed", ["authorization_code"], "read write", [REDIRECT], "default",
      undefined, undefined, undefined, "enrollment",
    );
    const c = (await provider.getClient(doomed.clientId))!;
    const issued = await provider.issueEnrollment({ sourceId: "tina", clientId: doomed.clientId });
    await storage.engine().query(
      "UPDATE oauth_clients SET deleted_at = NOW() WHERE client_id = $1",
      [doomed.clientId],
    );
    expect(await provider.getClient(doomed.clientId)).toBeUndefined();
    const res = await post(c, issued.code);
    // The handler looks the client up itself, so a revoked one is unknown.
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain("unknown client");
  });

  it("refuses a TTL that would overflow a date, and an unknown read source", async () => {
    await expect(
      provider.issueEnrollment({ sourceId: "tina", ttlSeconds: 99_999_999_999 * 86_400 }),
    ).rejects.toThrow(/ttl must be between/);
    await expect(
      provider.issueEnrollment({ sourceId: "tina", federatedRead: ["tina", "ghost"] }),
    ).rejects.toThrow(/Unknown source 'ghost'/);
  });
});
