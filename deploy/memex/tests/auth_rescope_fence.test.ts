/**
 * `auth rescope-client` can set AND clear the slug-prefix write fence.
 *
 * Before this the fence could only be applied at registration, so adding or
 * lifting one meant revoking + re-registering the client — which rotates its
 * secret. The flag is tri-state: absent leaves the stored fence alone, an empty
 * value clears it, a list replaces it.
 */
import { afterEach, beforeEach, describe, expect, it, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { OAuthProvider } from "../src/core/oauth-provider.ts";
import { parseFenceFlag } from "../src/commands/auth.ts";

describe("rescopeClient — bound_slug_prefixes", () => {
  let tmp: string;
  let storage: Storage;
  let provider: OAuthProvider;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "memex-rescope-"));
    storage = new Storage({ dbPath: join(tmp, "db") });
    await storage.init();
    provider = new OAuthProvider({ engine: storage.raw() });
  });

  afterEach(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  async function fence(clientId: string): Promise<string[] | null> {
    const r = await storage
      .raw()
      .query<{ bound_slug_prefixes: string[] | null }>(
        "SELECT bound_slug_prefixes FROM oauth_clients WHERE client_id = $1",
        [clientId],
      );
    return r.rows[0]?.bound_slug_prefixes ?? null;
  }

  async function register(name: string, prefixes?: string[]): Promise<string> {
    const reg = await provider.registerClientManual(
      name,
      ["client_credentials"],
      "read write",
      [],
      "default",
      undefined,
      undefined,
      prefixes,
    );
    return reg.clientId;
  }

  it("replaces an existing fence, leaves it alone when omitted, and clears it", async () => {
    const id = await register("fenced", ["inbox"]);
    expect(await fence(id)).toEqual(["inbox"]);

    expect(
      await provider.rescopeClient(id, "default", undefined, ["projects", "people"]),
    ).toBe(true);
    expect(await fence(id)).toEqual(["projects", "people"]);

    // Omitted → untouched: a tenancy-only rescope must not lift the fence.
    expect(await provider.rescopeClient(id, "default")).toBe(true);
    expect(await fence(id)).toEqual(["projects", "people"]);

    // Empty list → cleared (unbounded).
    expect(await provider.rescopeClient(id, "default", undefined, [])).toBe(true);
    expect(await fence(id)).toBeNull();
  });

  it("applies a fence to a client registered without one", async () => {
    const id = await register("unfenced");
    expect(await fence(id)).toBeNull();
    expect(await provider.rescopeClient(id, "default", undefined, ["inbox"])).toBe(true);
    expect(await fence(id)).toEqual(["inbox"]);
  });

  it("rejects a prefix that cannot match the slug grammar", async () => {
    const id = await register("strict");
    await expect(
      provider.rescopeClient(id, "default", undefined, ["NOT A SLUG"]),
    ).rejects.toThrow();
    expect(await fence(id)).toBeNull();
  });

  it("still reports false for an unknown client", async () => {
    expect(await provider.rescopeClient("memex_cl_missing", "default", undefined, ["inbox"])).toBe(
      false,
    );
  });
});

describe("--bound-slug-prefixes flag parsing", () => {
  test("absent → untouched; empty → cleared; list → replaced", () => {
    expect(parseFenceFlag(undefined)).toBeUndefined();
    expect(parseFenceFlag("")).toEqual([]);
    expect(parseFenceFlag(" , ")).toEqual([]);
    expect(parseFenceFlag("inbox, projects")).toEqual(["inbox", "projects"]);
  });
});
