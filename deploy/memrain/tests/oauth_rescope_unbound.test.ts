/**
 * A rescope that moves a client's tenant deletes its unbound codes and tokens.
 *
 * An unbound token takes its tenant from the client row at verification. When
 * the operator changes that row's write source, or switches the client to
 * enrollment mode, a token issued under the old grant would otherwise carry its
 * holder into the new source. Grant-bound (enrolled) tokens carry their own
 * tenant and survive; client_credentials-only clients keep following the row.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import {
  GrantConflictError,
  InvalidTokenError,
  OAuthProvider,
  type GrantMutationOptions,
  type OAuthClientInfo,
  type OAuthTokens,
} from "../src/core/oauth-provider.ts";
import { registerSource } from "../src/core/sources.ts";

const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const CLI: GrantMutationOptions = { actor: "test", via: "cli" };

let tmp: string;
let storage: Storage;
let provider: OAuthProvider;
let seq = 0;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-rescope-unbound-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  await registerSource(storage.engine(), { id: "tina", kind: "other", pathPrefix: "tenant:tina" });
  await registerSource(storage.engine(), { id: "victim", kind: "other", pathPrefix: "tenant:victim" });
  provider = new OAuthProvider({ engine: storage.raw() });
}, 30_000);

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
}, 30_000);

async function register(
  authMethod: string | undefined,
  mode: "client" | "enrollment",
): Promise<{ client: OAuthClientInfo }> {
  seq++;
  const reg = await provider.registerClientManual(
    `rescope-${seq}`,
    ["authorization_code", "refresh_token"],
    "read write",
    [REDIRECT],
    "default",
    undefined,
    authMethod,
    undefined,
    mode,
  );
  return { client: (await provider.getClient(reg.clientId))! };
}

async function code(client: OAuthClientInfo, grant?: Parameters<OAuthProvider["authorize"]>[2]): Promise<string> {
  const { redirectUrl } = await provider.authorize(client, { redirectUri: REDIRECT, codeChallenge: CHALLENGE }, grant);
  return new URL(redirectUrl).searchParams.get("code")!;
}

async function unboundPair(client: OAuthClientInfo): Promise<OAuthTokens> {
  return provider.exchangeAuthorizationCode(client, await code(client), undefined, REDIRECT);
}

async function enrolledPair(client: OAuthClientInfo, source: string): Promise<OAuthTokens> {
  const { code: enr } = await provider.issueEnrollment({ sourceId: source, clientId: client.client_id });
  const grant = await provider.claimEnrollment(enr, client.client_id);
  if (!grant) throw new Error("enrollment claim failed");
  return provider.exchangeAuthorizationCode(client, await code(client, grant), undefined, REDIRECT);
}

describe("rescope across a tenant move", () => {
  it("stops an unbound token once a public client moves to enrollment mode", async () => {
    const { client } = await register("none", "client");
    const pair = await unboundPair(client);
    const pending = await code(client);
    expect((await provider.verifyAccessToken(pair.access_token)).sourceId).toBe("default");

    const res = await provider.rescopeClient(
      client.client_id,
      { sourceId: "victim", tenantMode: "enrollment" },
      CLI,
    );
    expect(res.revokedUnbound).toEqual({ accessTokens: 1, refreshTokens: 1, codes: 1 });
    await expect(provider.verifyAccessToken(pair.access_token)).rejects.toBeInstanceOf(InvalidTokenError);
    const rescoped = (await provider.getClient(client.client_id))!;
    await expect(provider.exchangeRefreshToken(rescoped, pair.refresh_token!)).rejects.toThrow();
    await expect(provider.exchangeAuthorizationCode(rescoped, pending, undefined, REDIRECT)).rejects.toThrow();
  });

  it("stops an unbound token when only the write source changes", async () => {
    const { client } = await register(undefined, "client");
    const pair = await unboundPair(client);

    const res = await provider.rescopeClient(client.client_id, { sourceId: "victim" }, CLI);
    expect(res.changed).toContain("source_id");
    expect(res.revokedUnbound).toEqual({ accessTokens: 1, refreshTokens: 1, codes: 0 });
    await expect(provider.verifyAccessToken(pair.access_token)).rejects.toBeInstanceOf(InvalidTokenError);
    await expect(provider.exchangeRefreshToken(client, pair.refresh_token!)).rejects.toThrow();
  });

  it("previews the count on a dry run and deletes nothing", async () => {
    const { client } = await register(undefined, "client");
    const pair = await unboundPair(client);

    const dry = await provider.rescopeClient(client.client_id, { sourceId: "victim" }, { ...CLI, dryRun: true });
    expect(dry.revokedUnbound).toEqual({ accessTokens: 1, refreshTokens: 1, codes: 0 });
    expect((await provider.verifyAccessToken(pair.access_token)).sourceId).toBe("default");
  });

  it("keeps an unbound token that only sees a scope change", async () => {
    const { client } = await register(undefined, "client");
    const pair = await unboundPair(client);

    const res = await provider.rescopeClient(
      client.client_id,
      { sourceId: "default", federatedRead: ["default", "tina"], boundSlugPrefixes: ["inbox"] },
      CLI,
    );
    expect(res.revokedUnbound).toEqual({ accessTokens: 0, refreshTokens: 0, codes: 0 });
    const info = await provider.verifyAccessToken(pair.access_token);
    expect(info.sourceId).toBe("default");
    expect(info.allowedSources).toEqual(["default", "tina"]);
  });
});

describe("what a rescope leaves alone", () => {
  it("keeps enrolled tokens through a scope-only rescope and a source change", async () => {
    const { client } = await register(undefined, "enrollment");
    const pair = await enrolledPair(client, "tina");

    const scopesOnly = await provider.rescopeClient(
      client.client_id,
      { sourceId: "default", boundSlugPrefixes: ["inbox"] },
      CLI,
    );
    expect(scopesOnly.revokedUnbound).toEqual({ accessTokens: 0, refreshTokens: 0, codes: 0 });
    expect((await provider.verifyAccessToken(pair.access_token)).sourceId).toBe("tina");

    await provider.rescopeClient(client.client_id, { sourceId: "victim" }, CLI);
    expect((await provider.verifyAccessToken(pair.access_token)).sourceId).toBe("tina");
    const next = await provider.exchangeRefreshToken(client, pair.refresh_token!);
    expect((await provider.verifyAccessToken(next.access_token)).sourceId).toBe("tina");
  });

  it("lets a confidential client sign in and refresh under the new source", async () => {
    const { client } = await register(undefined, "client");
    await unboundPair(client);
    await provider.rescopeClient(client.client_id, { sourceId: "tina" }, CLI);

    const pair = await unboundPair(client);
    expect((await provider.verifyAccessToken(pair.access_token)).sourceId).toBe("tina");
    const next = await provider.exchangeRefreshToken(client, pair.refresh_token!);
    expect((await provider.verifyAccessToken(next.access_token)).sourceId).toBe("tina");
  });

  it("keeps a client_credentials-only token following the client row", async () => {
    const reg = await provider.registerClientManual("machine", ["client_credentials"], "read", [], "default");
    const tokens = await provider.exchangeClientCredentials(reg.clientId, reg.clientSecret!);

    const res = await provider.rescopeClient(reg.clientId, { sourceId: "tina", tenantMode: "enrollment" }, CLI);
    expect(res.revokedUnbound).toEqual({ accessTokens: 0, refreshTokens: 0, codes: 0 });
    expect((await provider.verifyAccessToken(tokens.access_token)).sourceId).toBe("tina");
  });
});

/**
 * Starts `rescope` the moment an exchange's consume statement returns, from
 * outside any transaction, so it lands in the gap between consuming the old
 * credential and inserting the new tokens unless the exchange holds it off.
 */
async function rescopeMidExchange<T>(
  consumeSql: string,
  rescope: () => Promise<unknown>,
  exchange: () => Promise<T>,
): Promise<{ result: T; rescoped: unknown }> {
  const engine = storage.raw();
  const original = engine.query;
  const outside = AsyncLocalStorage.snapshot();
  let started: Promise<unknown> | undefined;
  engine.query = (async (sql: string, params?: unknown[]) => {
    const r = await original.call(engine, sql, params);
    if (!started && sql.trimStart().startsWith(consumeSql)) {
      started = outside(rescope);
      // Give the rescope every chance to run before the exchange goes on.
      await new Promise((res) => setTimeout(res, 20));
    }
    return r;
  }) as typeof engine.query;
  try {
    const result = await exchange();
    expect(started).toBeDefined();
    return { result, rescoped: await started };
  } finally {
    engine.query = original;
  }
}

describe("rescope racing an exchange", () => {
  it("revokes the tokens a refresh issues while an enrollment rescope runs", async () => {
    const { client } = await register("none", "client");
    const pair = await unboundPair(client);

    const { result: late, rescoped } = await rescopeMidExchange(
      "DELETE FROM oauth_tokens",
      () => provider.rescopeClient(client.client_id, { sourceId: "victim", tenantMode: "enrollment" }, CLI),
      () => provider.exchangeRefreshToken(client, pair.refresh_token!),
    );
    // The pair's own access token plus the refresh's new pair.
    expect((rescoped as { revokedUnbound: unknown }).revokedUnbound).toEqual({
      accessTokens: 2,
      refreshTokens: 1,
      codes: 0,
    });
    await expect(provider.verifyAccessToken(late.access_token)).rejects.toBeInstanceOf(InvalidTokenError);
    const rescopedClient = (await provider.getClient(client.client_id))!;
    await expect(provider.exchangeRefreshToken(rescopedClient, late.refresh_token!)).rejects.toThrow();
  });

  it("revokes the tokens a code exchange issues while a source rescope runs", async () => {
    const { client } = await register(undefined, "client");
    const pending = await code(client);

    const { result: late, rescoped } = await rescopeMidExchange(
      "DELETE FROM oauth_codes",
      () => provider.rescopeClient(client.client_id, { sourceId: "victim" }, CLI),
      () => provider.exchangeAuthorizationCode(client, pending, undefined, REDIRECT),
    );
    expect((rescoped as { revokedUnbound: unknown }).revokedUnbound).toEqual({
      accessTokens: 1,
      refreshTokens: 1,
      codes: 0,
    });
    await expect(provider.verifyAccessToken(late.access_token)).rejects.toBeInstanceOf(InvalidTokenError);
    await expect(provider.exchangeRefreshToken(client, late.refresh_token!)).rejects.toThrow();
  });
});

/**
 * Runs `rescope` to completion right after authorize() reads the client row its
 * approval stands on, so the rescope commits before the code goes in.
 */
async function rescopeMidAuthorize(rescope: () => Promise<unknown>, authorize: () => Promise<unknown>): Promise<void> {
  const engine = storage.raw();
  const original = engine.query;
  const outside = AsyncLocalStorage.snapshot();
  let started: Promise<unknown> | undefined;
  engine.query = (async (sql: string, params?: unknown[]) => {
    const r = await original.call(engine, sql, params);
    if (!started && sql.trimStart().startsWith("SELECT grant_revision")) {
      started = outside(rescope);
      await started;
    }
    return r;
  }) as typeof engine.query;
  try {
    await authorize();
  } finally {
    engine.query = original;
    expect(started).toBeDefined();
    await started;
  }
}

async function unboundCodes(clientId: string): Promise<number> {
  const r = await storage.raw().query("SELECT 1 FROM oauth_codes WHERE client_id = $1 AND NOT grant_bound", [clientId]);
  return r.rows.length;
}

describe("rescope racing an authorize", () => {
  it("refuses a public client's code once a source rescope lands after the approval", async () => {
    const { client } = await register("none", "client");

    await expect(
      rescopeMidAuthorize(
        () => provider.rescopeClient(client.client_id, { sourceId: "victim" }, CLI),
        () => code(client),
      ),
    ).rejects.toThrow(GrantConflictError);
    expect(await unboundCodes(client.client_id)).toBe(0);
  });

  it("refuses the code when the rescope moves the client to enrollment mode", async () => {
    const { client } = await register("none", "client");

    await expect(
      rescopeMidAuthorize(
        () => provider.rescopeClient(client.client_id, { sourceId: "victim", tenantMode: "enrollment" }, CLI),
        () => code(client),
      ),
    ).rejects.toThrow(GrantConflictError);
    expect(await unboundCodes(client.client_id)).toBe(0);
  });

  it("leaves a confidential client's authorize and exchange unchanged", async () => {
    const { client } = await register(undefined, "client");
    const pair = await provider.exchangeAuthorizationCode(client, await code(client), undefined, REDIRECT);
    expect((await provider.verifyAccessToken(pair.access_token)).sourceId).toBe("default");
    expect(await unboundCodes(client.client_id)).toBe(0);
  });
});
