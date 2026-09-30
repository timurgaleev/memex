/**
 * Per-member revoke after redemption.
 *
 * `revoke-enrollment` only kills a code nobody used yet. Once a person has
 * redeemed hers on a shared connector, the operator needs to cut off that one
 * grant — her access and refresh tokens — without touching the other people
 * enrolled on the same client.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import {
  InvalidTokenError,
  OAuthProvider,
  type OAuthClientInfo,
  type OAuthTokens,
} from "../src/core/oauth-provider.ts";
import { registerSource } from "../src/core/sources.ts";
import { handleTokenRoute } from "../src/http/oauth-endpoints.ts";

const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

let tmp: string;
let storage: Storage;
let provider: OAuthProvider;
let team: OAuthClientInfo;
let teamSecret: string;

/** Enroll one person on the team connector and redeem her code end to end. */
async function enrollAndRedeem(source: string): Promise<{ id: string; tokens: OAuthTokens }> {
  const { id, code } = await provider.issueEnrollment({ sourceId: source, clientId: team.client_id });
  const grant = await provider.claimEnrollment(code, team.client_id);
  if (!grant) throw new Error("enrollment claim failed");
  const { redirectUrl } = await provider.authorize(
    team,
    { redirectUri: REDIRECT, codeChallenge: CHALLENGE },
    grant,
  );
  const authCode = new URL(redirectUrl).searchParams.get("code")!;
  const tokens = await provider.exchangeAuthorizationCode(team, authCode, undefined, REDIRECT);
  return { id, tokens };
}

function refresh(refreshToken: string): Promise<Response> {
  return handleTokenRoute(
    new Request("http://brain.example.test/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: team.client_id,
        client_secret: teamSecret,
      }).toString(),
    }),
    provider,
  );
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-revoke-grant-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  const e = storage.engine();
  await registerSource(e, { id: "tina", kind: "other", pathPrefix: "tenant:tina" });
  await registerSource(e, { id: "rachel", kind: "other", pathPrefix: "tenant:rachel" });
  provider = new OAuthProvider({ engine: storage.raw() });
  const reg = await provider.registerClientManual(
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
  teamSecret = reg.clientSecret!;
  team = (await provider.getClient(reg.clientId))!;
}, 30_000);

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
}, 30_000);

describe("revokeGrant", () => {
  it("cuts off one member and leaves the other on the same client working", async () => {
    const tina = await enrollAndRedeem("tina");
    const rachel = await enrollAndRedeem("rachel");
    expect((await provider.verifyAccessToken(tina.tokens.access_token)).sourceId).toBe("tina");

    // A redeemed code is past what revoke-enrollment can reach.
    expect(await provider.revokeEnrollment(tina.id)).toBe(false);

    const r = await provider.revokeGrant(tina.id);
    expect(r.revoked).toBe(true);
    expect(r.tokens).toBe(2); // her access + refresh

    await expect(provider.verifyAccessToken(tina.tokens.access_token)).rejects.toBeInstanceOf(
      InvalidTokenError,
    );
    const denied = await refresh(tina.tokens.refresh_token!);
    expect(denied.status).toBe(400);
    expect(((await denied.json()) as { error: string }).error).toBe("invalid_grant");

    // Rachel is untouched: her token verifies and her refresh rotates.
    expect((await provider.verifyAccessToken(rachel.tokens.access_token)).sourceId).toBe("rachel");
    const rotated = await refresh(rachel.tokens.refresh_token!);
    expect(rotated.status).toBe(200);
    const next = (await rotated.json()) as OAuthTokens;
    expect((await provider.verifyAccessToken(next.access_token)).sourceId).toBe("rachel");

    const listed = (await provider.listEnrollments()).find((x) => x.id === tina.id)!;
    expect(listed.revoked_at).not.toBeNull();
  });

  it("rejects a token or code minted under a grant that is already revoked", async () => {
    // Tokens that slip in while the revoke runs are not deleted by it; the
    // verify / refresh / code-exchange guards must stop them on their own.
    const { id, code } = await provider.issueEnrollment({ sourceId: "tina", clientId: team.client_id });
    const grant = (await provider.claimEnrollment(code, team.client_id))!;
    const minted = async () => {
      const { redirectUrl } = await provider.authorize(
        team,
        { redirectUri: REDIRECT, codeChallenge: CHALLENGE },
        grant,
      );
      return new URL(redirectUrl).searchParams.get("code")!;
    };
    const early = await provider.exchangeAuthorizationCode(team, await minted(), undefined, REDIRECT);
    const pendingCode = await minted();
    await storage
      .raw()
      .query("UPDATE oauth_enrollments SET revoked_at = NOW() WHERE id = $1", [id]);

    await expect(provider.verifyAccessToken(early.access_token)).rejects.toBeInstanceOf(
      InvalidTokenError,
    );
    expect((await refresh(early.refresh_token!)).status).toBe(400);
    await expect(
      provider.exchangeAuthorizationCode(team, pendingCode, undefined, REDIRECT),
    ).rejects.toThrow();
  });

  it("cuts off a token redeemed before grant_id existed (migration 108)", async () => {
    await registerSource(storage.engine(), { id: "olga", kind: "other", pathPrefix: "tenant:olga" });
    await registerSource(storage.engine(), { id: "paula", kind: "other", pathPrefix: "tenant:paula" });
    const olga = await enrollAndRedeem("olga");
    const paula = await enrollAndRedeem("paula");
    // What a pre-108 redemption left behind: grant-bound, no grant_id.
    await storage
      .raw()
      .query("UPDATE oauth_tokens SET grant_id = NULL WHERE source_id IN ('olga', 'paula')");
    const legacyRefresh = await refresh(olga.tokens.refresh_token!);
    expect(legacyRefresh.status).toBe(200); // rotation carries the NULL forward
    const rotated = (await legacyRefresh.json()) as OAuthTokens;

    const r = await provider.revokeGrant(olga.id);
    expect(r.tokens).toBe(3); // first access, rotated access + refresh
    await expect(provider.verifyAccessToken(rotated.access_token)).rejects.toBeInstanceOf(
      InvalidTokenError,
    );
    expect((await refresh(rotated.refresh_token!)).status).toBe(400);

    // Another member's legacy token on the same client is a different source.
    expect((await provider.verifyAccessToken(paula.tokens.access_token)).sourceId).toBe("paula");
  });

  it("rejects a legacy token a refresh inserts after the revoke ran", async () => {
    await registerSource(storage.engine(), { id: "quinn", kind: "other", pathPrefix: "tenant:quinn" });
    await registerSource(storage.engine(), { id: "rita", kind: "other", pathPrefix: "tenant:rita" });
    const quinn = await enrollAndRedeem("quinn");
    const rita = await enrollAndRedeem("rita");
    const db = storage.raw();
    await db.query("UPDATE oauth_tokens SET grant_id = NULL WHERE source_id IN ('quinn', 'rita')");
    // The refresh has consumed its row and holds what it will insert; the
    // revoke then runs and finds nothing of hers left to delete.
    const pending = await db.query<Record<string, unknown>>(
      `SELECT token_hash, token_type, client_id, scopes, expires_at, resource, created_at,
              source_id, federated_read, grant_bound, grant_id
         FROM oauth_tokens WHERE source_id = 'quinn'`,
    );
    expect(pending.rows.length).toBe(2);
    await provider.revokeGrant(quinn.id);
    // Now the refresh inserts: one row stamped before the revoke, one after.
    for (const row of pending.rows) {
      await db.query(
        `INSERT INTO oauth_tokens
           (token_hash, token_type, client_id, scopes, expires_at, resource, created_at,
            source_id, federated_read, grant_bound, grant_id)
         VALUES ($1, $2, $3, $4::text[], $5, $6, $7,
                 $8, $9::text[], $10, $11)`,
        [
          row.token_hash, row.token_type, row.client_id, row.scopes, row.expires_at, row.resource,
          row.created_at, row.source_id, row.federated_read, row.grant_bound, row.grant_id,
        ],
      );
    }
    await db.query(
      `UPDATE oauth_tokens SET created_at = NOW() + interval '1 second'
        WHERE source_id = 'quinn' AND token_type = 'refresh'`,
    );

    await expect(provider.verifyAccessToken(quinn.tokens.access_token)).rejects.toBeInstanceOf(
      InvalidTokenError,
    );
    expect((await refresh(quinn.tokens.refresh_token!)).status).toBe(400);

    // Rita is legacy on the same client too, but in another source.
    expect((await provider.verifyAccessToken(rita.tokens.access_token)).sourceId).toBe("rita");
    const rotated = await refresh(rita.tokens.refresh_token!);
    expect(rotated.status).toBe(200);
    const next = (await rotated.json()) as OAuthTokens;
    expect((await provider.verifyAccessToken(next.access_token)).sourceId).toBe("rita");
  });

  it("reports an unknown id", async () => {
    expect(await provider.revokeGrant("memex_enr_nope")).toEqual({ revoked: false, tokens: 0 });
  });

  it("does not touch tokens that carry no grant", async () => {
    const plain = await provider.registerClientManual(
      "cc", ["client_credentials"], "read", [], "default",
    );
    const tok = await provider.exchangeClientCredentials(plain.clientId, plain.clientSecret!);
    await provider.revokeGrant("memex_enr_nope");
    expect((await provider.verifyAccessToken(tok.access_token)).clientId).toBe(plain.clientId);
  });
});
