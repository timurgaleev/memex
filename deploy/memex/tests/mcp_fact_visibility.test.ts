/**
 * mig-085 fact visibility across the MCP surface — two halves of one contract.
 *
 * READ  — every non-operator principal (public ingress OR a tenant token) is
 *         floored to world-visible facts on BOTH fact-reading tools, and the
 *         floor does not depend on MEMEX_PUBLIC_READ_BODIES (that flag governs
 *         free-text bodies, never a visibility grant).
 * WRITE — `add_fact` can set the column, so a tenant agent can publish a fact it
 *         is then able to recall; public ingress cannot.
 *
 * Offline: PGLite Storage, no Bedrock.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { dispatchTool, type ToolCallResult } from "../src/mcp/dispatch.ts";
import { addFact } from "../src/core/facts.ts";
import { registerSource } from "../src/core/sources.ts";
import type { AuthInfo } from "../src/core/auth-info.ts";

const SOURCE = "vis-tenant";
const ENTITY = "people/vera";
const PRIVATE_FACT = "Vera's compensation review is scheduled for March.";
const WORLD_FACT = "Vera speaks Portuguese.";

const tenant: AuthInfo = {
  token: "tok-vis",
  clientId: "client-vis",
  scopes: ["read", "write"],
  sourceId: SOURCE,
  allowedSources: [SOURCE],
  isPublic: false,
};

let tmp: string;
let storage: Storage;

function payload(result: ToolCallResult): any {
  expect(result.isError).toBeFalsy();
  return JSON.parse(result.content[0]!.text);
}

const asTenant = (name: string, args: Record<string, unknown>) =>
  dispatchTool(storage, { name, arguments: args }, { authInfo: tenant });
const asPublic = (name: string, args: Record<string, unknown>) =>
  dispatchTool(storage, { name, arguments: args }, { isPublic: true });
const asOperator = (name: string, args: Record<string, unknown>) =>
  dispatchTool(storage, { name, arguments: args });

async function visibilityOf(fact: string): Promise<string | undefined> {
  const r = await storage
    .engine()
    .query<{ visibility: string }>(
      "SELECT visibility FROM entity_facts WHERE fact = $1",
      [fact],
    );
  return r.rows[0]?.visibility;
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-fact-vis-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  await registerSource(storage.engine(), {
    id: SOURCE,
    kind: "vault",
    pathPrefix: "/vis",
  });
  await addFact(storage, {
    entity_slug: ENTITY,
    fact: PRIVATE_FACT,
    source_id: SOURCE,
    visibility: "private",
  });
  await addFact(storage, {
    entity_slug: ENTITY,
    fact: WORLD_FACT,
    source_id: SOURCE,
    visibility: "world",
  });
});

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("fact visibility floor — tenant reads", () => {
  it("entity_facts hides a private fact from a tenant", async () => {
    const out = payload(await asTenant("entity_facts", { entity_slug: ENTITY }));
    const texts = out.facts.map((f: any) => f.fact);
    expect(texts).toContain(WORLD_FACT);
    expect(texts).not.toContain(PRIVATE_FACT);
  });

  it("entity_recall hides a private fact from a tenant", async () => {
    const res = await asTenant("entity_recall", { slug: ENTITY });
    const out = payload(res);
    const texts = out.facts.map((f: any) => f.fact);
    expect(texts).toContain(WORLD_FACT);
    expect(texts).not.toContain(PRIVATE_FACT);
    expect(res.content[0]!.text).not.toContain(PRIVATE_FACT);
  });

  it("the operator still reads both visibilities back", async () => {
    const facts = payload(await asOperator("entity_facts", { entity_slug: ENTITY }));
    expect(facts.facts.map((f: any) => f.fact)).toContain(PRIVATE_FACT);
    const recall = payload(await asOperator("entity_recall", { slug: ENTITY }));
    expect(recall.facts.map((f: any) => f.fact)).toContain(PRIVATE_FACT);
  });
});

describe("fact visibility floor — public ingress with MEMEX_PUBLIC_READ_BODIES", () => {
  const ORIGINAL = process.env["MEMEX_PUBLIC_READ_BODIES"];
  beforeEach(() => {
    process.env["MEMEX_PUBLIC_READ_BODIES"] = "1";
  });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env["MEMEX_PUBLIC_READ_BODIES"];
    else process.env["MEMEX_PUBLIC_READ_BODIES"] = ORIGINAL;
  });

  it("entity_facts still hides a private fact when bodies are opted in", async () => {
    const res = await asPublic("entity_facts", { entity_slug: ENTITY });
    expect(res.content[0]!.text).not.toContain(PRIVATE_FACT);
  });

  it("entity_recall still hides a private fact when bodies are opted in", async () => {
    const res = await asPublic("entity_recall", { slug: ENTITY });
    expect(res.content[0]!.text).not.toContain(PRIVATE_FACT);
  });
});

describe("add_fact visibility write contract", () => {
  it("a tenant can publish a world fact and recall it back", async () => {
    const claim = "Vera prefers async standups.";
    payload(
      await asTenant("add_fact", {
        entity_slug: ENTITY,
        fact: claim,
        visibility: "world",
      }),
    );
    expect(await visibilityOf(claim)).toBe("world");
    const back = payload(await asTenant("entity_facts", { entity_slug: ENTITY }));
    expect(back.facts.map((f: any) => f.fact)).toContain(claim);
  });

  it("an omitted visibility still lands private (unchanged default)", async () => {
    const claim = "Vera joined in 2019.";
    payload(await asTenant("add_fact", { entity_slug: ENTITY, fact: claim }));
    expect(await visibilityOf(claim)).toBe("private");
  });

  it("an out-of-enum visibility is refused, not silently downgraded", async () => {
    const res = await asTenant("add_fact", {
      entity_slug: ENTITY,
      fact: "Vera runs the Lisbon office.",
      visibility: "public-ish",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("visibility");
    expect(await visibilityOf("Vera runs the Lisbon office.")).toBeUndefined();
  });

  it("public ingress cannot publish a world fact", async () => {
    const claim = "Vera was seen at the conference.";
    payload(
      await asPublic("add_fact", {
        entity_slug: ENTITY,
        fact: claim,
        visibility: "world",
      }),
    );
    expect(await visibilityOf(claim)).toBe("private");
  });
});
