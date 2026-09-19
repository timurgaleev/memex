/**
 * People enrolled on one shared connector each have their own daily budget.
 *
 * Locks: a token redeemed from an enrollment spends under the enrollment id,
 * through code → access → refresh; the enrollment's own cap applies, else the
 * connector's cap per person; one person spending their cap does not refuse
 * another; and a token issued outside enrollment still spends as its client.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { OAuthProvider, type OAuthClientInfo } from "../src/core/oauth-provider.ts";
import { registerSource } from "../src/core/sources.ts";
import { runWithSpendClient, setSpendLedgerEngine, trackedInvoke } from "../src/core/budget.ts";

const HAIKU = "eu.anthropic.claude-haiku-4-5-20251001-v1:0";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const CB = "https://example.invalid/cb";

let tmp: string;
let storage: Storage;
let provider: OAuthProvider;
let client: OAuthClientInfo;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-enroll-cap-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  setSpendLedgerEngine(storage.engine());
  const e = storage.engine();
  await registerSource(e, { id: "alice", kind: "other", pathPrefix: "tenant:alice" });
  await registerSource(e, { id: "bob", kind: "other", pathPrefix: "tenant:bob" });
  provider = new OAuthProvider({ engine: storage.raw() });
  const reg = await provider.registerClientManual(
    "team-connector",
    ["authorization_code", "refresh_token"],
    "read write",
    [CB],
    "default",
  );
  client = (await provider.getClient(reg.clientId))!;
});
afterAll(async () => {
  setSpendLedgerEngine(null);
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

/** Enroll someone into `source` and run the whole OAuth dance for them. */
async function enroll(source: string) {
  const issued = await provider.issueEnrollment({ sourceId: source, label: source });
  const grant = await provider.claimEnrollment(issued.code, client.client_id);
  const { redirectUrl } = await provider.authorize(
    client,
    { redirectUri: CB, codeChallenge: CHALLENGE, scopes: ["read", "write"] },
    grant,
  );
  const code = new URL(redirectUrl).searchParams.get("code")!;
  const tokens = await provider.exchangeAuthorizationCode(client, code, undefined, CB);
  return { enrollmentId: issued.id, tokens };
}

/** Spend `usd` of Haiku input as the principal behind `token`. */
async function spendAs(token: string, usd: number): Promise<void> {
  const info = await provider.verifyAccessToken(token);
  await runWithSpendClient({ clientId: info.spendId ?? info.clientId, capUsd: info.budgetUsdPerDay }, () =>
    trackedInvoke({ operation: "think", model: HAIKU, worstCase: { input: "x", maxOutputTokens: 0 } }, async (m) => {
      m.report({ inputTokens: Math.round(usd * 1_000_000), outputTokens: 0 });
    }),
  );
}

describe("an enrolled person's spend", () => {
  it("is booked under their enrollment, and survives a refresh", async () => {
    const alice = await enroll("alice");
    const info = await provider.verifyAccessToken(alice.tokens.access_token);
    expect(info.clientId).toBe(client.client_id);
    expect(info.spendId).toBe(alice.enrollmentId);

    const rotated = await provider.exchangeRefreshToken(client, alice.tokens.refresh_token!);
    expect((await provider.verifyAccessToken(rotated.access_token)).spendId).toBe(alice.enrollmentId);
  });

  it("is capped per person, so one person's spent day does not refuse another", async () => {
    expect(await provider.setClientBudget(client.client_id, 0.5)).toBe(true);
    const alice = await enroll("alice");
    const bob = await enroll("bob");
    expect((await provider.verifyAccessToken(alice.tokens.access_token)).budgetUsdPerDay).toBe(0.5);

    await spendAs(alice.tokens.access_token, 0.6);
    await expect(spendAs(alice.tokens.access_token, 0.01)).rejects.toMatchObject({ code: "budget_exhausted" });
    await spendAs(bob.tokens.access_token, 0.1);
  });

  it("falls back to the connector's cap on the lookup path too", async () => {
    await provider.setClientBudget(client.client_id, 0.5);
    const alice = await enroll("alice");
    // A spend context rebuilt from the bare id (no cap carried) finds the same cap.
    await runWithSpendClient(alice.enrollmentId, () =>
      trackedInvoke({ operation: "think", model: HAIKU, worstCase: { input: "x", maxOutputTokens: 0 } }, async (m) => {
        m.report({ inputTokens: 600_000, outputTokens: 0 });
      }),
    );
    await expect(
      runWithSpendClient(alice.enrollmentId, () =>
        trackedInvoke({ operation: "think", model: HAIKU, worstCase: { input: "x", maxOutputTokens: 0 } }, async () => {}),
      ),
    ).rejects.toMatchObject({ code: "budget_exhausted" });
  });

  it("takes the enrollment's own cap over the connector's", async () => {
    await provider.setClientBudget(client.client_id, 10);
    const alice = await enroll("alice");
    expect(await provider.setClientBudget(alice.enrollmentId, 0.25)).toBe(true);
    expect((await provider.verifyAccessToken(alice.tokens.access_token)).budgetUsdPerDay).toBe(0.25);
  });

  it("leaves a token issued outside enrollment spending as its client", async () => {
    const { redirectUrl } = await provider.authorize(client, {
      redirectUri: CB,
      codeChallenge: CHALLENGE,
      scopes: ["read"],
    });
    const code = new URL(redirectUrl).searchParams.get("code")!;
    const tokens = await provider.exchangeAuthorizationCode(client, code, undefined, CB);
    expect((await provider.verifyAccessToken(tokens.access_token)).spendId).toBeUndefined();
  });
});
