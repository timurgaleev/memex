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
import type { GrantMutationResult } from "../src/core/oauth-provider.ts";
import { cliActor, parseExpectedRevision, parseFenceFlag, parseBoolFlag, parseFlags, runAuth } from "../src/commands/auth.ts";

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

  const OPTS = { actor: "test", via: "cli" } as const;
  function rescope(id: string, boundSlugPrefixes?: string[]): Promise<GrantMutationResult> {
    return provider.rescopeClient(id, { sourceId: "default", boundSlugPrefixes }, OPTS);
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

    await rescope(id, ["projects", "people"]);
    expect(await fence(id)).toEqual(["projects", "people"]);

    // Omitted → untouched: a tenancy-only rescope must not lift the fence.
    await rescope(id);
    expect(await fence(id)).toEqual(["projects", "people"]);

    // Empty list → cleared (unbounded).
    await rescope(id, []);
    expect(await fence(id)).toBeNull();
  });

  it("applies a fence to a client registered without one", async () => {
    const id = await register("unfenced");
    expect(await fence(id)).toBeNull();
    await rescope(id, ["inbox"]);
    expect(await fence(id)).toEqual(["inbox"]);
  });

  it("rejects a prefix that cannot match the slug grammar", async () => {
    const id = await register("strict");
    await expect(rescope(id, ["NOT A SLUG"])).rejects.toThrow("invalid_prefix");
    expect(await fence(id)).toBeNull();
  });

  it("reports not_found for an unknown client", async () => {
    await expect(rescope("memex_cl_missing", ["inbox"])).rejects.toThrow("not_found");
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

describe("rescope-client CLI helpers", () => {
  test("actor prefers MEMEX_OPERATOR, then USER, then 'cli'", () => {
    expect(cliActor({ MEMEX_OPERATOR: "ops", USER: "u" })).toBe("ops");
    expect(cliActor({ MEMEX_OPERATOR: " ", USER: "u" })).toBe("u");
    expect(cliActor({})).toBe("cli");
  });

  test("--expected-revision accepts only a non-negative integer", () => {
    expect(parseExpectedRevision(undefined)).toBeUndefined();
    expect(parseExpectedRevision("0")).toBe(0);
    expect(parseExpectedRevision("12")).toBe(12);
    for (const bad of ["", "-1", "1.5", "abc", "1e3"]) {
      expect(() => parseExpectedRevision(bad)).toThrow("--expected-revision");
    }
  });

  test("--dry-run parses without a value, and junk is refused", () => {
    const { positional, flags } = parseFlags(["x", "--dry-run", "--source", "a"]);
    expect(positional).toEqual(["x"]);
    expect(flags).toEqual({ "dry-run": "true", "source": "a" });
    expect(parseBoolFlag("dry-run", flags["dry-run"])).toBe(true);
    expect(parseBoolFlag("dry-run", parseFlags(["--dry-run=no"]).flags["dry-run"])).toBe(false);
    expect(parseBoolFlag("dry-run", undefined)).toBe(false);
    expect(() => parseBoolFlag("dry-run", "maybe")).toThrow("boolean flag");
  });

  test("--dry-run on any other auth subcommand is refused before it can mutate", async () => {
    await expect(runAuth(["revoke-client", "memex_cl_x", "--dry-run"])).rejects.toThrow(
      "only by rescope-client",
    );
    await expect(runAuth(["set-budget", "memex_cl_x", "5", "--dry-run=true"])).rejects.toThrow(
      "only by rescope-client",
    );
  });
});
