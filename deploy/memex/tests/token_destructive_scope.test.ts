/**
 * Destructive MCP tools over the token-authenticated ingress.
 *
 * Reference model: delete/restore/revert/unlink/remove_tag/forget_fact are
 * `scope: write`, purge_deleted_pages is `scope: admin`. An authenticated
 * token principal whose grant covers the op may call it (source-scoped); the
 * static public bearer and the bare internal path (no internal token) stay
 * refused exactly as before.
 */
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { startServer, type ServerHandle } from "../src/http/server.ts";
import { OAuthProvider } from "../src/core/oauth-provider.ts";
import { getPage } from "../src/core/pages.ts";

const PUB_TOKEN = "pub-bearer-xyz789";
const INT_TOKEN = "internal-shared-token-abcdef";
const ERR_UNAUTHORIZED = -32001;

// Each test does several sequential OAuth mint + /mcp round-trips against an
// in-process pglite; the default 5s is too tight here (pathologically slow
// under local AV load — see CLAUDE.md), so raise the floor.
setDefaultTimeout(120_000);

let tmp: string;
let storage: Storage;
let provider: OAuthProvider;
let server: ServerHandle;
let url: string;

/** client_credentials token for a client registered with `scope`. */
async function mint(scope: string, sourceId = "default"): Promise<string> {
  const reg = await provider.registerClientManual(
    `t-${scope.replace(/ /g, "-")}-${sourceId}`,
    ["client_credentials"],
    scope,
    [],
    sourceId,
  );
  const r = await fetch(`${url}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: reg.clientId,
      client_secret: reg.clientSecret!,
    }),
  });
  expect(r.status).toBe(200);
  return ((await r.json()) as { access_token: string }).access_token;
}

async function call(
  name: string,
  args: Record<string, unknown>,
  bearer?: string,
  headers: Record<string, string> = {},
): Promise<any> {
  // A bearer-carrying call models the real ingress (behind Cloudflare →
  // public guard 401 → token verified → authInfo). A bare call models the
  // docker-bridge internal path.
  const r = await fetch(`${url}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(bearer
        ? { Authorization: `Bearer ${bearer}`, "Cf-Connecting-Ip": "1.2.3.4" }
        : {}),
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  return r.json();
}

function toolError(rpc: any): string | undefined {
  if (rpc.error) return String(rpc.error.message ?? rpc.error.code);
  if (rpc.result?.isError) {
    try {
      return JSON.parse(rpc.result.content[0].text).error;
    } catch {
      return rpc.result.content[0]?.text;
    }
  }
  return undefined;
}

beforeEach(async () => {
  process.env.MEMEX_PUBLIC_WRITE = "1"; // prod posture: constructive writes on
  tmp = mkdtempSync(join(tmpdir(), "memex-tok-destr-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  provider = new OAuthProvider({ engine: storage.raw() });
  server = startServer({
    host: "127.0.0.1",
    port: 0,
    storage,
    publicBearerToken: PUB_TOKEN,
    internalToken: INT_TOKEN,
    oauthProvider: provider,
  });
  url = `http://127.0.0.1:${server.port}`;
});

afterEach(async () => {
  await server.stop();
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.MEMEX_PUBLIC_WRITE;
});

describe("write-scoped token on destructive tools", () => {
  it("page_delete: write token soft-deletes its own source's page", async () => {
    const writer = await mint("read write");
    const put = await call("page_put", { slug: "notes/doomed", type: "note" }, writer);
    expect(toolError(put)).toBeUndefined();

    const del = await call("page_delete", { slug: "notes/doomed" }, writer);
    expect(toolError(del)).toBeUndefined();
    expect(JSON.parse(del.result.content[0].text).ok).toBe(true);

    const page = await getPage(storage, "notes/doomed", undefined, {
      includeDeleted: true,
    });
    expect(page?.deleted_at).toBeTruthy();
  });

  it("page_restore: write token undeletes what it deleted", async () => {
    const writer = await mint("read write");
    await call("page_put", { slug: "notes/phoenix", type: "note" }, writer);
    await call("page_delete", { slug: "notes/phoenix" }, writer);
    const res = await call("page_restore", { slug: "notes/phoenix" }, writer);
    expect(toolError(res)).toBeUndefined();
    const page = await getPage(storage, "notes/phoenix");
    expect(page).toBeTruthy();
    expect(page?.deleted_at ?? null).toBeNull();
  });

  it("read-scoped token is refused with insufficient_scope (not the internal-token wall)", async () => {
    const reader = await mint("read");
    const del = await call("page_delete", { slug: "notes/whatever" }, reader);
    expect(toolError(del)).toBe("insufficient_scope");
  });

  it("page_delete is source-scoped: a token cannot delete another source's page", async () => {
    const other = await mint("read write", "othersrc");
    await call("page_put", { slug: "notes/mine", type: "note" }, other);

    const writer = await mint("read write"); // source: default
    await call("page_delete", { slug: "notes/mine" }, writer);

    const page = await getPage(storage, "notes/mine", ["othersrc"]);
    expect(page).toBeTruthy();
    expect(page?.deleted_at ?? null).toBeNull();
  });

  it("static public bearer stays forbidden from the public ingress", async () => {
    const del = await call(
      "page_delete",
      { slug: "notes/x" },
      PUB_TOKEN,
      { "Cf-Connecting-Ip": "1.2.3.4" },
    );
    expect(del.error).toBeDefined();
    expect(del.error.message).toMatch(/not callable from the public ingress/);
  });

  it("bare internal path (no token at all) still hits the internal-token wall", async () => {
    const del = await call("page_delete", { slug: "notes/x" });
    expect(del.error?.code).toBe(ERR_UNAUTHORIZED);
    expect(del.error.message).toMatch(/internal token/);
  });
});

describe("purge_deleted_pages stays internal-token-only", () => {
  // The irreversible hard-delete is deliberately NOT in the token exemption
  // set, so even a fully-scoped token hits the internal-token wall — it is not
  // a reversible op a remote client should reach. (The legacy-PAT grandfather
  // grants every PAT admin, which is exactly why an admin-scoped exemption
  // would be an over-grant.)
  it("a token cannot hard-purge — internal token required", async () => {
    const admin = await mint("read write admin");
    const r = await call("purge_deleted_pages", { older_than_hours: 0 }, admin);
    expect(r.error?.code).toBe(ERR_UNAUTHORIZED);
    expect(r.error.message).toMatch(/internal token/);
  });
});
