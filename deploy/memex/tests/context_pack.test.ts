/**
 * context_pack — budgeted entity cards + top facts, grant-scoped.
 *
 * Runs against a PGLite brain seeded with the two-tenant fixture plus a few
 * pages of its own; the budget cases get a separate brain with 8 entities of
 * 25 long facts each so trimming actually bites.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { putPage } from "../src/core/pages.ts";
import { addFact } from "../src/core/facts.ts";
import { estTokens } from "../src/core/search/token-budget.ts";
import { buildContextPack, type ContextPack } from "../src/core/context/context-pack.ts";
import { dispatchTool, type ToolCallResult } from "../src/mcp/dispatch.ts";
import type { AuthInfo } from "../src/core/auth-info.ts";
import {
  A, A_FACT, auth, B, B_FACT, ENTITY_SLUG, seedTenantContract,
} from "./helpers/tenant_seed.ts";
import { TENANT_A_TOKENS, TENANT_B_TOKENS } from "./fixtures/tenant_isolation_matrix.ts";

setDefaultTimeout(60000);

const noGrant: AuthInfo = { token: "tok-none", clientId: "client-none", scopes: ["read"], isPublic: false };

function tmpStorage(prefix: string): { dir: string; storage: Storage } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, storage: new Storage({ dbPath: join(dir, "db") }) };
}

function packOf(r: ToolCallResult): ContextPack & { ok: boolean } {
  return JSON.parse(r.content[0]!.text);
}

function serializedCost(p: ContextPack): number {
  return estTokens(JSON.stringify({ cards: p.cards, facts: p.facts }));
}

describe("context_pack over the two-tenant brain", () => {
  let dir: string;
  let storage: Storage;
  const call = async (args: Record<string, unknown>, authInfo?: AuthInfo) =>
    packOf(await dispatchTool(storage, { name: "context_pack", arguments: args }, authInfo ? { authInfo } : {}));

  beforeAll(async () => {
    ({ dir, storage } = tmpStorage("memex-context-pack-"));
    await storage.init();
    await seedTenantContract(storage);
    await putPage(storage, { slug: "projects/quokka", type: "note", title: "Quokka Rollout", markdown_body: "QUOKKA_BODY" });
    await addFact(storage, { entity_slug: "projects/quokka", fact: "Quokka ships in March", confidence: 0.9 });
    await putPage(storage, { slug: "projects/wombat", type: "note", title: "Wombat Migration", markdown_body: "w" });
    await addFact(storage, { entity_slug: "projects/wombat", fact: "Wombat moves to RDS", confidence: 0.8 });
    for (let i = 0; i < 12; i++) {
      await putPage(storage, { slug: `crowd/p${i}`, type: "person", title: `Crowd ${i}`, markdown_body: "c" });
    }
    // Soft-stub: facts without a page.
    await addFact(storage, { entity_slug: "people/ghost", fact: "GHOST_FACT stub only", confidence: 0.95 });
    // Tenant A: one world fact and one private fact on its own page.
    await addFact(storage, { entity_slug: "team-a/alice", fact: "AAA_WORLD visible fact", source_id: A, visibility: "world" });
    await addFact(storage, { entity_slug: "team-a/alice", fact: "AAA_PRIVATE hidden fact", source_id: A, visibility: "private" });
    await addFact(storage, { entity_slug: "team-b/alice", fact: "BBB_WORLD other tenant", source_id: B, visibility: "world" });
    // Diary content in tenant A: one by slug prefix, one by page type.
    await putPage(storage, { slug: "life/diary/2026-01-01", type: "journal", title: "Diary Day", markdown_body: "d", source_id: A, allowAdHocType: true });
    await addFact(storage, { entity_slug: "life/diary/2026-01-01", fact: "AAA_DIARY_FACT", source_id: A, visibility: "world" });
    await putPage(storage, { slug: "notes/musings", type: "journal", title: "Musings", markdown_body: "m", source_id: A, allowAdHocType: true });
  });

  afterAll(async () => {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  afterEach(() => {
    delete process.env["MEMEX_TENANT_FAIL_CLOSED"];
  });

  it("puts explicit slugs before window-resolved entities, and cards before facts", async () => {
    const p = await call({ slugs: ["projects/wombat"], window: "user: how is the Quokka Rollout going?" });
    expect(p.ok).toBe(true);
    expect(p.cards.map(c => c.slug)).toEqual(["projects/wombat", "projects/quokka"]);
    expect(p.facts.length).toBeGreaterThan(0);
    expect(Object.keys(p)).toEqual(["ok", "cards", "facts", "budget"]);
  });

  it("dedupes explicit slugs and window mentions of the same entity", async () => {
    const p = await call({
      slugs: ["projects/quokka", "projects/quokka", "projects/wombat"],
      window: "user: Quokka Rollout and Wombat Migration",
    });
    expect(p.cards.map(c => c.slug)).toEqual(["projects/quokka", "projects/wombat"]);
  });

  it("never builds more than 8 cards, even for 12 slugs and a larger max", async () => {
    const slugs = Array.from({ length: 12 }, (_, i) => `crowd/p${i}`);
    const viaTool = await call({ slugs, max_entities: 8, token_budget: 8000 });
    expect(viaTool.cards).toHaveLength(8);
    const direct = await buildContextPack(storage, { slugs, maxEntities: 50, tokenBudget: 8000 });
    expect(direct.cards.map(c => c.slug)).toEqual(slugs.slice(0, 8));
    const byDefault = await call({ slugs, token_budget: 8000 });
    expect(byDefault.cards).toHaveLength(5);
  });

  it("gives a missing slug and an out-of-grant slug byte-identical output", async () => {
    const hidden = await call({ slugs: ["team-b/alice"] }, auth(A));
    const missing = await call({ slugs: ["team-b/nobody-here"] }, auth(A));
    expect(JSON.stringify(hidden)).toBe(JSON.stringify(missing));
    expect(hidden.cards).toEqual([]);
    const malformed = await call({ slugs: ["Not A Slug!", 42] }, auth(A));
    expect(malformed.cards).toEqual([]);
  });

  it("builds no card for a soft-stub entity", async () => {
    const p = await call({ slugs: ["people/ghost"] });
    expect(p.cards).toEqual([]);
  });

  it("keeps card facts out of the brain facts", async () => {
    const p = await call({ slugs: ["people/ghost", "projects/quokka"], facts_limit: 25, token_budget: 8000 });
    const onCards = new Set(p.cards.flatMap(c => c.facts.map(f => f.id)));
    expect(onCards.size).toBeGreaterThan(0);
    for (const f of p.facts) expect(onCards.has(f.id)).toBe(false);
    expect(p.facts.some(f => f.entity_slug === "projects/quokka")).toBe(false);
  });

  it("shows the operator both tenants' facts on a shared entity", async () => {
    const p = await call({ slugs: [ENTITY_SLUG], token_budget: 8000 });
    const card = p.cards.find(c => c.slug === ENTITY_SLUG)!;
    const text = card.facts.map(f => f.fact).join(" ");
    expect(text).toContain(A_FACT);
    expect(text).toContain(B_FACT);
    expect(JSON.stringify(card)).not.toContain("markdown_body");
  });

  it("holds no tenant bytes for a caller with no grant", async () => {
    process.env["MEMEX_TENANT_FAIL_CLOSED"] = "1";
    const p = await call(
      { slugs: [ENTITY_SLUG, "team-a/alice", "team-b/alice"], window: "Quokka Rollout", token_budget: 8000 },
      noGrant,
    );
    expect(p.cards).toEqual([]);
    expect(p.facts).toEqual([]);
    expect(p.budget.used_tokens).toBeLessThan(20);
    const body = JSON.stringify(p).toLowerCase();
    for (const t of [...TENANT_A_TOKENS, ...TENANT_B_TOKENS]) expect(body).not.toContain(t.toLowerCase());
  });

  it("floors a remote caller to world-visible facts inside its grant", async () => {
    const p = await call({ slugs: ["team-a/alice"], facts_limit: 25, token_budget: 8000 }, auth(A));
    const body = JSON.stringify(p);
    expect(body).toContain("AAA_WORLD");
    expect(body).not.toContain("AAA_PRIVATE");
    expect(body).not.toContain(A_FACT); // seeded private
    for (const t of TENANT_B_TOKENS) expect(body.toLowerCase()).not.toContain(t.toLowerCase());
  });

  it("fences diary entities from a remote caller, by slug and by page type", async () => {
    const remote = await call(
      { slugs: ["life/diary/2026-01-01", "notes/musings"], facts_limit: 25, token_budget: 8000 },
      auth(A),
    );
    expect(remote.cards).toEqual([]);
    expect(JSON.stringify(remote)).not.toContain("AAA_DIARY_FACT");
    const missing = await call({ slugs: ["life/diary/1999-01-01", "notes/nothing"], facts_limit: 25, token_budget: 8000 }, auth(A));
    expect(JSON.stringify(remote)).toBe(JSON.stringify(missing));

    const operator = await call({ slugs: ["life/diary/2026-01-01", "notes/musings"] });
    expect(operator.cards.map(c => c.slug)).toEqual(["life/diary/2026-01-01", "notes/musings"]);
  });

  it("returns top brain facts under the budget for an empty call", async () => {
    const p = await call({});
    expect(p.cards).toEqual([]);
    expect(p.facts.length).toBeGreaterThan(0);
    expect(p.budget.token_budget).toBe(1500);
    expect(p.budget.used_tokens).toBeLessThanOrEqual(1500);
  });

  it("rejects a non-array `slugs`", async () => {
    const r = await dispatchTool(storage, { name: "context_pack", arguments: { slugs: "projects/quokka" } }, {});
    expect(r.isError).toBe(true);
  });
});

describe("context_pack budget", () => {
  let dir: string;
  let storage: Storage;
  const ENTITIES = Array.from({ length: 8 }, (_, i) => `people/e${i}`);
  const LONG = "x".repeat(280);

  beforeAll(async () => {
    ({ dir, storage } = tmpStorage("memex-context-pack-budget-"));
    await storage.init();
    for (const [i, slug] of ENTITIES.entries()) {
      await putPage(storage, { slug, type: "person", title: `Entity ${i}`, markdown_body: "b" });
      for (let j = 0; j < 25; j++) {
        await addFact(storage, { entity_slug: slug, fact: `e${i} fact ${j} ${LONG}`, confidence: 0.5 + j / 100 });
      }
      await storage.engine().query(
        `INSERT INTO timeline_events (slug, occurred_at, event, detail, source_label, source_chunk_id)
         VALUES ($1, '2026-01-0${(i % 9) + 1}T00:00:00Z', $2, '', '', NULL)`,
        [slug, `event for e${i} ${LONG}`],
      );
    }
  });

  afterAll(async () => {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  for (const budget of [200, 800, 8000]) {
    it(`stays within ${budget} tokens and counts what it dropped`, async () => {
      const p = await buildContextPack(storage, { slugs: ENTITIES, maxEntities: 8, tokenBudget: budget, decay: true });
      expect(p.budget.token_budget).toBe(budget);
      expect(p.budget.used_tokens).toBeLessThanOrEqual(budget);
      expect(serializedCost(p)).toBeLessThanOrEqual(p.budget.used_tokens);
      expect(p.cards.length + p.budget.cards_dropped).toBe(8);
      expect(p.facts.length + p.budget.facts_dropped).toBe(10);
      const cardFacts = p.cards.reduce((n, c) => n + c.facts.length, 0);
      expect(cardFacts + p.budget.card_facts_dropped).toBe(5 * p.cards.length);
      const cardEvents = p.cards.reduce((n, c) => n + c.recent.length, 0);
      expect(cardEvents + p.budget.card_events_dropped).toBe(p.cards.length);
      // Facts only once every card is in.
      if (p.facts.length > 0) expect(p.budget.cards_dropped).toBe(0);
      expect(p.cards.length).toBeGreaterThan(0);
    });
  }

  it("clamps the budget into 200..8000", async () => {
    const low = await buildContextPack(storage, { tokenBudget: 5 });
    expect(low.budget.token_budget).toBe(200);
    const high = await buildContextPack(storage, { tokenBudget: 1_000_000 });
    expect(high.budget.token_budget).toBe(8000);
  });
});
