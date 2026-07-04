/**
 * `auth rescope-client` — re-point an existing OAuth client's write source +
 * read federation in place (id/secret unchanged), the operator's way to widen a
 * client's world without re-issuing credentials. Validates source existence.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { registerSource } from "../src/core/sources.ts";
import { OAuthProvider } from "../src/core/oauth-provider.ts";

let tmp: string;
let storage: Storage;
let provider: OAuthProvider;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-rescope-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  provider = new OAuthProvider({ engine: storage.raw() });
  const e = storage.raw();
  await registerSource(e, { id: "gmail", kind: "mailbox", pathPrefix: "tenant:gmail" });
  await registerSource(e, { id: "obsidian-vault", kind: "vault", pathPrefix: "tenant:vault" });
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("OAuthProvider.rescopeClient", () => {
  it("widens an existing client's read federation without changing its id", async () => {
    const c = await provider.registerClientManual(
      "web",
      ["authorization_code"],
      "read write",
      ["https://x/cb"],
      "default",
      ["default"],
      "none",
    );
    const updated = await provider.rescopeClient(c.clientId, {
      federatedRead: ["default", "gmail", "obsidian-vault"],
    });
    expect(updated?.client_id).toBe(c.clientId); // id unchanged
    expect((updated?.federated_read ?? []).sort()).toEqual([
      "default",
      "gmail",
      "obsidian-vault",
    ]);
  });

  it("rejects an unknown source (never leaves a dangling scope)", async () => {
    const c = await provider.registerClientManual(
      "web2", ["authorization_code"], "read", ["https://x/cb"], "default", ["default"], "none",
    );
    await expect(
      provider.rescopeClient(c.clientId, { federatedRead: ["default", "nope"] }),
    ).rejects.toThrow(/unknown source/i);
  });

  it("returns null for an unknown client_id", async () => {
    const r = await provider.rescopeClient("memex_cl_doesnotexist", {
      federatedRead: ["default"],
    });
    expect(r).toBeNull();
  });
});
