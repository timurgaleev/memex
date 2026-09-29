/**
 * Fail-closed multi-tenant read policy (MEMEX_TENANT_FAIL_CLOSED).
 *
 * The guard closes one hole: an AUTHENTICATED principal that holds no source
 * grant used to resolve to `undefined` scope = the redacted whole brain. With
 * the flag on, that caller reads NOTHING. The discriminator is `authInfo`
 * presence, not the `isPublic` bit (see the security note in auth-info.ts:
 * keying on `isPublic` would let an OAuth tenant pose as trusted-local): ANY
 * caller that presents an `authInfo` — public OR an `isPublic:false` OAuth
 * tenant — is scoped to its grant, and a scopeless one reads nothing. The two
 * paths the daily service depends on both present `authInfo === undefined`, so
 * the guard never touches them:
 *
 *   (a) the static public bearer — dispatched with `authInfo === undefined`
 *       (the Claude Code path). Whole-brain, redacted, ALWAYS.
 *   (b) the trusted-local / CLI / internal path (`authInfo === undefined`).
 *       Whole-brain.
 *
 * Bedrock-free: seeds via core writers + the det-embed seam, asserts through
 * dispatchTool. No `search` (needs embeddings); get_chunks is a direct SQL read.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { dispatchTool, type ToolCallResult, type DispatchOptions } from "../src/mcp/dispatch.ts";
import { putPage } from "../src/core/pages.ts";
import { registerSource } from "../src/core/sources.ts";
import { indexPageIntoSearch } from "../src/core/page-index.ts";
import type { AuthInfo } from "../src/core/auth-info.ts";
import { deterministicEmbed } from "./det-embed.ts";

const embedFn = async (text: string) => deterministicEmbed(text);

const A_SLUG = "companies/fc-a";
const B_SLUG = "companies/fc-b";
const A_SECRET = "FailClosed-Tenant-A: token-alpha-7731";
const B_SECRET = "FailClosed-Tenant-B: token-beta-2244";
// A-only chunk token so a get_chunks leak is unambiguous.
const A_CHUNK_SECRET = "FailClosedChunkSecret-lynx-basalt-6620";

const ENV_KEY = "MEMEX_TENANT_FAIL_CLOSED";

let tmp: string;
let storage: Storage;

/** An authenticated PUBLIC principal that holds NO grant — the ONLY identity
 *  the fail-closed guard is allowed to bite. */
function publicNoGrant(): AuthInfo {
  return {
    token: "tok-public-nogrant",
    clientId: "client-public-nogrant",
    scopes: ["read"],
    isPublic: true,
  };
}

/** An authenticated OAuth tenant (`isPublic:false`) with NO grant. It presents
 *  an `authInfo`, so it is NOT the trusted-local/operator path (that presents
 *  `authInfo === undefined`) — under fail-closed it reads NOTHING, same as an
 *  authed-public no-grant caller. With the flag OFF it stays whole-brain. */
function oauthNoGrant(): AuthInfo {
  return {
    token: "tok-oauth-nogrant",
    clientId: "client-oauth-nogrant",
    scopes: ["read", "write"],
    isPublic: false,
  };
}

/** An OAuth principal WITH a federated grant to a single source. */
function oauthGrant(sourceId: string): AuthInfo {
  return {
    token: `tok-${sourceId}`,
    clientId: `client-${sourceId}`,
    scopes: ["read", "write"],
    sourceId,
    allowedSources: [sourceId],
    isPublic: false,
  };
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-failclosed-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  const e = storage.engine();
  await registerSource(e, { id: "a", kind: "vault", pathPrefix: "/tenant-a" });
  await registerSource(e, { id: "b", kind: "vault", pathPrefix: "/tenant-b" });

  await putPage(storage, { slug: A_SLUG, type: "company", title: "FC A", markdown_body: A_SECRET, source_id: "a" });
  await putPage(storage, { slug: B_SLUG, type: "company", title: "FC B", markdown_body: B_SECRET, source_id: "b" });

  // A's page body mirrored into the search store (documents+chunks) under
  // source 'a', offline via the det-embed seam, so get_chunks has real rows.
  await indexPageIntoSearch(
    storage,
    { slug: A_SLUG, title: "FC A", markdown_body: A_CHUNK_SECRET, source_id: "a" },
    { embedFn },
  );
});

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

// The flag is process-wide; restore it after every test so cases can't leak.
afterEach(() => {
  delete process.env[ENV_KEY];
});

function payload(result: ToolCallResult): any {
  expect(result.content[0]?.type).toBe("text");
  return JSON.parse(result.content[0]!.text);
}

async function call(name: string, args: Record<string, unknown>, opts: DispatchOptions): Promise<any> {
  return payload(await dispatchTool(storage, { name, arguments: args }, opts));
}

/** The static public bearer: dispatched with `isPublic` true but NO authInfo. */
const STATIC_BEARER: DispatchOptions = { isPublic: true };

/** Build DispatchOptions for an authInfo principal, mirroring the transport:
 *  isPublic on the envelope tracks the identity's own trust bit. */
function via(auth: AuthInfo): DispatchOptions {
  return { isPublic: auth.isPublic, authInfo: auth };
}

describe("default (flag unset) — behavior identical to today", () => {
  it("static-bearer-equivalent (authInfo undefined, isPublic true) → whole-brain", async () => {
    const all = JSON.stringify(await call("page_list", {}, STATIC_BEARER));
    expect(all).toContain(A_SLUG);
    expect(all).toContain(B_SLUG);
  });

  it("OAuth-with-grant → exactly its grant", async () => {
    const a = JSON.stringify(await call("page_list", {}, via(oauthGrant("a"))));
    expect(a).toContain(A_SLUG);
    expect(a).not.toContain(B_SLUG);
  });

  it("OAuth-no-grant (isPublic:false) → whole-brain", async () => {
    const all = JSON.stringify(await call("page_list", {}, via(oauthNoGrant())));
    expect(all).toContain(A_SLUG);
    expect(all).toContain(B_SLUG);
  });

  it("authenticated PUBLIC no-grant → whole-brain (redacted) when flag OFF (unchanged fail-OPEN)", async () => {
    const all = JSON.stringify(await call("page_list", {}, via(publicNoGrant())));
    // Slugs remain (bodies redacted); both tenants visible — the pre-guard behavior.
    expect(all).toContain(A_SLUG);
    expect(all).toContain(B_SLUG);
  });
});

describe("MEMEX_TENANT_FAIL_CLOSED=1 — the guard bites every authenticated no-grant caller", () => {
  it("authenticated PUBLIC principal with no grant reads NOTHING", async () => {
    process.env[ENV_KEY] = "1";
    const out = await call("page_list", {}, via(publicNoGrant()));
    const s = JSON.stringify(out);
    expect(s).not.toContain(A_SLUG);
    expect(s).not.toContain(B_SLUG);
    expect(out.pages).toEqual([]);
  });

  it("static bearer (authInfo undefined) STILL reads whole-brain — Claude Code unaffected", async () => {
    process.env[ENV_KEY] = "1";
    const all = JSON.stringify(await call("page_list", {}, STATIC_BEARER));
    expect(all).toContain(A_SLUG);
    expect(all).toContain(B_SLUG);
  });

  it("OAuth tenant (isPublic:false, no grant) reads NOTHING — authInfo present is scoped, not trusted-local", async () => {
    process.env[ENV_KEY] = "1";
    const out = await call("page_list", {}, via(oauthNoGrant()));
    const s = JSON.stringify(out);
    expect(s).not.toContain(A_SLUG);
    expect(s).not.toContain(B_SLUG);
    expect(out.pages).toEqual([]);
  });

  it("OAuth principal WITH a grant still reads exactly its grant", async () => {
    process.env[ENV_KEY] = "1";
    const a = JSON.stringify(await call("page_list", {}, via(oauthGrant("a"))));
    expect(a).toContain(A_SLUG);
    expect(a).not.toContain(B_SLUG);
  });
});

describe("empty-scope is honored fail-closed through a real read (get_chunks)", () => {
  it("flag OFF: authed-public-no-grant get_chunks sees A's chunk (fail-open baseline)", async () => {
    const out = await call("get_chunks", { slug: A_SLUG }, via(publicNoGrant()));
    expect(JSON.stringify(out)).toContain(A_CHUNK_SECRET);
  });

  it("flag ON: authed-public-no-grant get_chunks returns NO cross-tenant rows", async () => {
    process.env[ENV_KEY] = "1";
    const out = await call("get_chunks", { slug: A_SLUG }, via(publicNoGrant()));
    expect(out.chunks).toEqual([]);
    expect(JSON.stringify(out)).not.toContain(A_CHUNK_SECRET);
  });

  it("flag ON: static bearer get_chunks STILL sees A's chunk (whole-brain preserved)", async () => {
    process.env[ENV_KEY] = "1";
    const out = await call("get_chunks", { slug: A_SLUG }, STATIC_BEARER);
    expect(JSON.stringify(out)).toContain(A_CHUNK_SECRET);
  });
});
