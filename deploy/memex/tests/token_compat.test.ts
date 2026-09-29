/**
 * Tokens under the pre-rename `memex_` prefixes and the current `memrain_`
 * ones are the same to every reader: lookups go by SHA-256 hash or plain
 * equality and never parse a prefix, the secret scanner redacts both
 * families, and PAT names may not squat either family's generated ids.
 *
 * Fixture secrets are assembled at run time so no literal credential shape
 * sits in the repository for a scanner to trip on.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { OAuthProvider } from "../src/core/oauth-provider.ts";
import { patNameSpendConflict } from "../src/core/budget.ts";
import { fingerprintSecret, scanSecrets } from "../src/core/secret-scan.ts";

const sha = (v: string) => createHash("sha256").update(v, "utf8").digest("hex");
const hex = (bytes: number) => randomBytes(bytes).toString("hex");

let tmp: string;
let storage: Storage;
let provider: OAuthProvider;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-token-compat-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  provider = new OAuthProvider({ engine: storage.raw() });
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("token lookups ignore the prefix", () => {
  it("an access token authenticates under either prefix", async () => {
    const { clientId, clientSecret } = await provider.registerClientManual("svc", ["client_credentials"], "read write", []);
    const minted = await provider.exchangeClientCredentials(clientId, clientSecret!);
    const before = await provider.verifyAccessToken(minted.access_token);

    for (const prefix of ["memex", "memrain"]) {
      const token = `${prefix}_${"at"}_${hex(32)}`;
      await storage.raw().query(
        "UPDATE oauth_tokens SET token_hash = $1 WHERE token_type = 'access' AND client_id = $2",
        [sha(token), clientId],
      );
      const info = await provider.verifyAccessToken(token);
      expect(info.clientId).toBe(before.clientId);
      expect(info.scopes).toEqual(before.scopes);
    }
  });

  it("a confidential client secret verifies under either prefix", async () => {
    const { clientId, clientSecret } = await provider.registerClientManual("svc", ["client_credentials"], "read", []);
    expect((await provider.verifyConfidentialClientSecret(clientId, clientSecret!)).client_id).toBe(clientId);

    for (const prefix of ["memex", "memrain"]) {
      const secret = `${prefix}_${"cs"}_${hex(32)}`;
      await storage.raw().query("UPDATE oauth_clients SET client_secret_hash = $1 WHERE client_id = $2", [sha(secret), clientId]);
      expect((await provider.verifyConfidentialClientSecret(clientId, secret)).client_id).toBe(clientId);
      await expect(provider.verifyConfidentialClientSecret(clientId, `${secret}x`)).rejects.toThrow();
    }
  });

  it("a PAT authenticates under either prefix", async () => {
    for (const prefix of ["memex", "memrain"]) {
      const token = `${prefix}_${hex(32)}`;
      await storage.raw().query(
        "INSERT INTO access_tokens (name, token_hash, scopes) VALUES ($1, $2, $3::text[])",
        [`pat-${prefix}`, sha(token), ["read"]],
      );
      const info = await provider.verifyAccessToken(token);
      expect(info.clientId).toBe(`pat-${prefix}`);
    }
  });
});

describe("secret scan covers both token families", () => {
  it("redacts access, refresh, client secret, code and enrollment tokens and PATs", () => {
    for (const prefix of ["memex", "memrain"]) {
      const tokens = ["at", "rt", "cs", "code", "en"].map((kind) => `${prefix}_${kind}_${hex(32)}`);
      const pat = `${prefix}_${hex(32)}`;
      const r = scanSecrets([...tokens, pat].join("\n"));
      expect(r.findings.map((f) => f.kind)).toEqual([...tokens.map(() => `${prefix}-token`), `${prefix}-pat`]);
      expect(r.text).toBe(
        [...tokens.map((t) => `[REDACTED:${prefix}-token:${fingerprintSecret(t)}]`), `[REDACTED:${prefix}-pat:${fingerprintSecret(pat)}]`].join("\n"),
      );
    }
  });

  it("leaves client ids and enrollment ids of either family alone", () => {
    const text = ["memex", "memrain"].map((p) => `${p}_cl_${"f".repeat(64)} ${p}_enr_${"0".repeat(32)}`).join("\n");
    expect(scanSecrets(text)).toEqual({ text, findings: [] });
  });

  it("stays linear on near-miss runs of the new prefixes", () => {
    const time = (n: number) => {
      const s = `${"memrain_at_".repeat(n / 4)}${"memrain_".repeat(n / 4)}${"x".repeat(n)}`;
      const t = performance.now();
      scanSecrets(s);
      return performance.now() - t;
    };
    time(2000);
    const small = Math.max(time(20_000), 0.5);
    expect(time(80_000) / small).toBeLessThan(10);
  });
});

describe("PAT names cannot take a generated id's namespace", () => {
  it("rejects all four reserved prefixes and allows ordinary names", () => {
    for (const prefix of ["memrain_cl_", "memrain_enr_", "memex_cl_", "memex_enr_"]) {
      expect(patNameSpendConflict(`${prefix}abc`)).toContain(prefix);
    }
    expect(patNameSpendConflict("laptop")).toBeNull();
    expect(patNameSpendConflict("memrain_laptop")).toBeNull();
  });
});
