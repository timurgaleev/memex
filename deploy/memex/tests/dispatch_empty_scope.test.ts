/**
 * A caller granted NO source reads nothing through dispatch.
 *
 * `readSources` has three readings: `undefined` = the operator (whole brain),
 * `[]` / `[NO_SOURCE_SENTINEL]` = no grant (nothing), non-empty = those sources.
 * Dispatch used to collapse an empty scope back to `undefined` with
 * `readSources && readSources.length`, handing a grantless caller the whole brain.
 *
 * Ingress never builds a literal `[]` today, so the no-grant scope is driven the
 * way production reaches it: an authInfo with `allowedSources: []` and no
 * `sourceId`, under MEMEX_TENANT_FAIL_CLOSED=1 (resolves to the sentinel). Each
 * tool is checked both ways — the grantless caller sees no tenant token, the
 * operator (no authInfo) sees tenant B's.
 *
 * Hermetic: search/query use the deterministic embedder seam; think never
 * reaches runThink (its default-OFF reason would come back instead).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { dispatchTool, type DispatchOptions, type ToolCallResult } from "../src/mcp/dispatch.ts";
import { addTag } from "../src/core/tags.ts";
import type { AuthInfo } from "../src/core/auth-info.ts";
import { deterministicEmbed } from "./det-embed.ts";
import {
  A_BODY, A_FACT, A_SEARCH, A_TAKE, B, B_BODY, B_FACT, B_SEARCH, B_TAKE, ENTITY_SLUG, GATEWAY, KEYWORD,
  seedTenantContract, WIKI_NAME,
} from "./helpers/tenant_seed.ts";

setDefaultTimeout(30000);

const ENV_KEY = "MEMEX_TENANT_FAIL_CLOSED";
const embedQuery = async (text: string) => deterministicEmbed(text);

const B_PAGE = "team-b/alice";
const B_TAG = "bbb-private-tag-zebra";

// Every token that proves a read crossed into a tenant. Tool arguments (the
// shared gateway slug, the search keyword) are deliberately absent: a response
// may echo them without leaking anything.
const TENANT_TOKENS = [
  A_BODY, B_BODY, A_FACT, B_FACT, A_TAKE, B_TAKE, A_SEARCH, B_SEARCH, B_TAG,
  "team-a/alice", B_PAGE, "vault-a/target", "vault-b/target", "/tenant-a/notes.md", "/tenant-b/notes.md",
];

let tmp: string;
let storage: Storage;

function noGrant(): AuthInfo {
  return {
    token: "tok-empty-grant",
    clientId: "client-empty-grant",
    scopes: ["read"],
    allowedSources: [],
    isPublic: false,
  };
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-dispatch-empty-scope-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  await seedTenantContract(storage);
  await addTag(storage, B_PAGE, B_TAG, B);
});

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

afterEach(() => {
  delete process.env[ENV_KEY];
});

function payload(result: ToolCallResult): unknown {
  expect(result.content[0]?.type).toBe("text");
  return JSON.parse(result.content[0]!.text);
}

async function call(name: string, args: Record<string, unknown>, opts: DispatchOptions): Promise<string> {
  return JSON.stringify(payload(await dispatchTool(storage, { name, arguments: args }, opts)));
}

const OPERATOR: DispatchOptions = { embedQuery };
const NO_GRANT = (): DispatchOptions => ({ authInfo: noGrant(), embedQuery });

// [tool, args, a tenant-B token the operator must see]
const CASES: Array<[string, Record<string, unknown>, string]> = [
  ["search", { q: KEYWORD, k: 10 }, B_SEARCH],
  ["query", { q: KEYWORD, k: 10 }, B_SEARCH],
  ["get_chunks", { source_path: "/tenant-b/notes.md" }, B_BODY],
  ["page_list", {}, B_PAGE],
  ["get_tags", { slug: B_PAGE }, B_TAG],
  ["backlinks", { name: WIKI_NAME }, "/tenant-b/notes.md"],
  ["get_links", { slug: GATEWAY }, "vault-b/target"],
  ["entity_facts", { entity_slug: ENTITY_SLUG }, B_FACT],
  ["list_takes", {}, B_TAKE],
];

describe("no-grant caller reads nothing through dispatch", () => {
  for (const [tool, args, bToken] of CASES) {
    it(`${tool}: operator sees tenant B, a grantless caller sees no tenant`, async () => {
      const operator = await call(tool, args, OPERATOR);
      expect(operator).toContain(bToken);

      process.env[ENV_KEY] = "1";
      const scoped = await call(tool, args, NO_GRANT());
      const echoed = JSON.stringify(args);
      for (const token of TENANT_TOKENS) {
        if (!echoed.includes(token)) expect(scoped).not.toContain(token);
      }
    });
  }

  // think is write-scoped, so the fail-closed gate refuses a grantless caller
  // before callThink runs; the in-handler no-grant short-circuit is the backstop.
  it("think: a grantless caller gets no synthesis and no tenant token", async () => {
    const operator = JSON.parse(await call("think", { question: `what about ${KEYWORD}?` }, OPERATOR));
    expect(operator.reason).toContain("default-OFF");

    process.env[ENV_KEY] = "1";
    const raw = await call("think", { question: `what about ${KEYWORD}?` }, NO_GRANT());
    for (const token of TENANT_TOKENS) expect(raw).not.toContain(token);
    const out = JSON.parse(raw);
    expect(out.error).toBe("permission_denied");
    expect(out.synthesis).toBeUndefined();
  });
});
