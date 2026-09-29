/**
 * A personal access token gets the scopes its row records — nothing more.
 *
 * `verifyAccessToken` used to return `["read","write","admin"]` for every
 * `access_tokens` row and never look at the `scopes` column, while both mint
 * paths (`http/admin-api.ts`, `commands/auth.ts`) write `["read","write"]`.
 * The per-op gate in `mcp/dispatch.ts` was therefore satisfied for the admin
 * ops — including `purge_deleted_pages`, which hard-deletes.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Storage } from "../src/core/storage.ts";
import { OAuthProvider } from "../src/core/oauth-provider.ts";

let tmp: string;
let storage: Storage;
let provider: OAuthProvider;

const hash = (t: string) => createHash("sha256").update(t).digest("hex");

async function seed(name: string, token: string, scopes: string[] | null) {
  await storage.engine().query(
    `INSERT INTO access_tokens (name, token_hash, scopes, permissions)
     VALUES ($1, $2, $3::text[], $4::jsonb)`,
    [name, hash(token), scopes, { takes_holders: ["world"] }],
  );
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-pat-scopes-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  provider = new OAuthProvider({ engine: storage.raw() });
});

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("legacy PAT scopes", () => {
  it("a token minted read+write does NOT resolve to admin", async () => {
    await seed("mint-default", "tok-rw", ["read", "write"]);
    const info = await provider.verifyAccessToken("tok-rw");
    expect(info.scopes).toEqual(["read", "write"]);
    expect(info.scopes).not.toContain("admin");
  });

  it("a read-only token stays read-only", async () => {
    await seed("readonly", "tok-r", ["read"]);
    const info = await provider.verifyAccessToken("tok-r");
    expect(info.scopes).toEqual(["read"]);
  });

  it("a token the operator explicitly recorded as admin keeps admin", async () => {
    await seed("ops", "tok-admin", ["read", "write", "admin"]);
    const info = await provider.verifyAccessToken("tok-admin");
    expect(info.scopes).toContain("admin");
  });

  it("a row with no scopes recorded falls back to read+write, never admin", async () => {
    // Rows written before the column was populated. The conservative default
    // matches what both mint paths write today.
    await seed("legacy-null", "tok-null", null);
    const info = await provider.verifyAccessToken("tok-null");
    expect(info.scopes).toEqual(["read", "write"]);
    expect(info.scopes).not.toContain("admin");
  });

  it("a row recorded with NO scopes stays with none — stripping is not widening", async () => {
    // The fallback used to fire on `storedScopes.length === 0`, which cannot
    // tell "written before the column existed" (NULL) from "deliberately
    // stripped" (an empty array). An operator revoking a token's scopes was
    // handing it read+write instead. Only NULL takes the legacy default now.
    await seed("stripped", "tok-stripped", []);
    const info = await provider.verifyAccessToken("tok-stripped");
    expect(info.scopes).toEqual([]);
  });
});
