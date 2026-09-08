/**
 * Per-grant tenancy: one shared connector, several people, separate sources.
 *
 * A corporate chat vendor publishes ONE connector for a whole organisation and
 * every member authorises against it, so tenancy pinned to `oauth_clients` can
 * only ever be one tenant per connector. These tests pin the contract that lets
 * a single client serve many tenants: the source is chosen when the operator
 * approves that one authorization, travels with the code and the token, is
 * inherited (never re-derived) on refresh, and can never be influenced by the
 * token holder.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { OAuthProvider, type OAuthClientInfo } from "../src/core/oauth-provider.ts";
import { registerSource } from "../src/core/sources.ts";

let tmp: string;
let storage: Storage;
let provider: OAuthProvider;
let client: OAuthClientInfo;

// PKCE pair fixed for the suite: the challenge is never re-derived here, the
// exchange path under test does not verify it (handled a layer up).
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

async function codeFor(sourceId: string | null, federated?: string[] | null) {
  const { redirectUrl } = await provider.authorize(
    client,
    {
      redirectUri: "https://example.invalid/cb",
      codeChallenge: CHALLENGE,
      scopes: ["read", "write"],
    },
    { sourceId, federatedRead: federated ?? null },
  );
  return new URL(redirectUrl).searchParams.get("code")!;
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-grant-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  const e = storage.engine();
  await registerSource(e, { id: "alice", kind: "other", pathPrefix: "tenant:alice" });
  await registerSource(e, { id: "bob", kind: "other", pathPrefix: "tenant:bob" });
  provider = new OAuthProvider({ engine: storage.raw() });
  // One shared connector, registered against a THIRD source — the value every
  // token would inherit today.
  const reg = await provider.registerClientManual(
    "shared-connector",
    ["authorization_code", "refresh_token"],
    "read write",
    ["https://example.invalid/cb"],
    "default",
  );
  const looked = await provider.getClient(reg.clientId);
  if (!looked) throw new Error("client row missing after registration");
  client = looked;
});

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("per-grant tenancy", () => {
  it("two people on ONE client land in their own sources", async () => {
    const aliceCode = await codeFor("alice", ["alice"]);
    const bobCode = await codeFor("bob", ["bob"]);

    const aliceTokens = await provider.exchangeAuthorizationCode(
      client, aliceCode, undefined, "https://example.invalid/cb",
    );
    const bobTokens = await provider.exchangeAuthorizationCode(
      client, bobCode, undefined, "https://example.invalid/cb",
    );

    const a = await provider.verifyAccessToken(aliceTokens.access_token);
    const b = await provider.verifyAccessToken(bobTokens.access_token);

    expect(a.sourceId).toBe("alice");
    expect(a.allowedSources).toEqual(["alice"]);
    expect(b.sourceId).toBe("bob");
    expect(b.allowedSources).toEqual(["bob"]);
    // Same client for both — the whole point.
    expect(a.clientId).toBe(b.clientId);
  });

  it("refresh INHERITS the approved source instead of falling back to the client", async () => {
    const code = await codeFor("alice", ["alice"]);
    const first = await provider.exchangeAuthorizationCode(
      client, code, undefined, "https://example.invalid/cb",
    );
    expect(first.refresh_token).toBeTruthy();

    const rotated = await provider.exchangeRefreshToken(
      client, first.refresh_token!,
    );
    const after = await provider.verifyAccessToken(rotated.access_token);
    expect(after.sourceId).toBe("alice"); // NOT the client's "default"
    expect(after.allowedSources).toEqual(["alice"]);
  });

  it("a token issued WITHOUT a grant still resolves from the client row", async () => {
    // No third argument to authorize() — the pre-existing path.
    const { redirectUrl } = await provider.authorize(
      client,
      {
        redirectUri: "https://example.invalid/cb",
        codeChallenge: CHALLENGE,
        scopes: ["read"],
      },
    );
    const code = new URL(redirectUrl).searchParams.get("code")!;
    const tokens = await provider.exchangeAuthorizationCode(
      client, code, undefined, "https://example.invalid/cb",
    );
    const info = await provider.verifyAccessToken(tokens.access_token);
    expect(info.sourceId).toBe("default");
  });

  it("a grant naming an unregistered source is refused at authorize time", async () => {
    await expect(codeFor("ghost-tenant", ["ghost-tenant"])).rejects.toThrow(
      /Unknown source/,
    );
  });

  it("a grant pinned to NO source stays pinned — it must not widen to the client", async () => {
    const code = await codeFor(null, []);
    const tokens = await provider.exchangeAuthorizationCode(
      client, code, undefined, "https://example.invalid/cb",
    );
    const info = await provider.verifyAccessToken(tokens.access_token);
    expect(info.sourceId).toBeUndefined();
    expect(info.allowedSources).toEqual([]);
  });
});
