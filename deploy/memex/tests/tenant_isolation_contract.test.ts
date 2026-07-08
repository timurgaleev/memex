/**
 * Multi-tenant isolation — the CONTRACT sweep.
 *
 * The real cross-tenant failure mode is one forgotten read tool returning
 * "proof" (a chunk / page / fact / link / citation / tag / mention / take) from
 * the WRONG tenant's brain. `tenant_isolation.test.ts` locks the first wave of
 * read tools; THIS file extends the lock to every remaining read tool that
 * threads `readSources`, so a single un-scoped tool fails loudly + by name.
 *
 * Method: seed TWO sources ('tenantA' + 'tenantB') with deliberately COLLIDING
 * identifiers and per-tenant DISTINCTIVE private tokens, then drive each read
 * tool through the real `dispatchTool` path (or its underlying core fn) with a
 * caller scoped to one tenant and assert:
 *   - the result NEVER carries the other tenant's distinctive token / id;
 *   - the result DOES carry the caller's own content (positive control);
 *   - an UNSCOPED caller (no authInfo) still sees BOTH (behaviour-neutral).
 *
 * Colliding-identifier note: `pages.slug` is a GLOBAL primary key
 * (migrations/015_pages.sql:31) — two tenants cannot literally share a slug, so
 * the collision axis memex actually supports is exercised instead: a shared
 * ENTITY NAME (`Alice` wikilink), a shared CODE SYMBOL (`processPayment`), a
 * shared SOURCE PATH (`/shared/pay.ts`), a shared page TITLE, and a shared
 * graph START node (`shared/gateway`) whose per-source edges fan out to
 * distinct in-tenant targets. Each is a genuine cross-tenant collision that a
 * broken scope filter would leak through.
 *
 * Hermetic: no Bedrock. Search-store reads use the deterministic embedder seam
 * (tests/det-embed.ts); every other read is keyword / SQL only.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { dispatchTool, type ToolCallResult } from "../src/mcp/dispatch.ts";
import { putPage } from "../src/core/pages.ts";
import { addFact } from "../src/core/facts.ts";
import { addTimelineEvent } from "../src/core/timeline.ts";
import { addLink } from "../src/core/links.ts";
import { registerSource } from "../src/core/sources.ts";
import { indexPageIntoSearch } from "../src/core/page-index.ts";
import { hybridSearch } from "../src/core/search/hybrid.ts";
import { entityId, type EntityType } from "../src/core/entities.ts";
import { deterministicEmbed } from "./det-embed.ts";
import type { AuthInfo } from "../src/core/auth-info.ts";

// PGLite hybridSearch over the whole seeded store can edge past the 5s default.
setDefaultTimeout(30000);

const embedFn = async (text: string) => deterministicEmbed(text);

const A = "tenantA";
const B = "tenantB";

// --- Colliding identifiers (shared across BOTH tenants) --------------------
const ENTITY_SLUG = "people/alice"; // one global page; facts/timeline per-source
const WIKI_NAME = "Alice"; // shared wikilink entity — backlinks collision
const CODE_SYM = "processPayment"; // shared code symbol — code_* collision
const SHARED_PATH = "/shared/pay.ts"; // shared source_path — code_callees collision
const SHARED_TITLE = "Aardvark Shared Title"; // shared page title — resolve_slugs
const GATEWAY = "shared/gateway"; // shared graph start — traversal collision
const KEYWORD = "kangaroo"; // shared search keyword

// --- Per-tenant DISTINCTIVE private tokens ---------------------------------
const A_FACT = "AAA_FACT_TRAJECTORY_seed";
const B_FACT = "BBB_FACT_TRAJECTORY_seed";
const A_EVENT = "AAA_EVENT_TRAJECTORY_launch";
const B_EVENT = "BBB_EVENT_TRAJECTORY_launch";
const A_BODY = "AAA_SECRET_NOTES_BODY";
const B_BODY = "BBB_SECRET_NOTES_BODY";
const A_CALLEE = "chargeCardAAA";
const B_CALLEE = "chargeCardBBB";
const A_CALLER = "callerAAA";
const B_CALLER = "callerBBB";
const A_TAKE = "AAA_TAKE_SECRET_claim";
const B_TAKE = "BBB_TAKE_SECRET_claim";
const A_SEARCH = "KANGA_SECRET_AAA";
const B_SEARCH = "KANGA_SECRET_BBB";

// Document ids (TEXT PK, chosen so synth_takes.source_ref can point at them).
const DOC_A_NOTES = "doc-a-notes";
const DOC_B_NOTES = "doc-b-notes";
const DOC_A_CODE = "doc-a-code";
const DOC_B_CODE = "doc-b-code";

let tmp: string;
let storage: Storage;
let factIdA = 0;
let factIdB = 0;

function auth(sourceId: string): AuthInfo {
  return {
    token: `tok-${sourceId}`,
    clientId: `client-${sourceId}`,
    scopes: ["read", "write"],
    sourceId,
    allowedSources: [sourceId],
    isPublic: false,
  };
}

function payload(result: ToolCallResult): any {
  expect(result.content[0]?.type).toBe("text");
  return JSON.parse(result.content[0]!.text);
}

async function call(
  name: string,
  args: Record<string, unknown>,
  authInfo?: AuthInfo,
): Promise<any> {
  return payload(
    await dispatchTool(storage, { name, arguments: args }, authInfo ? { authInfo } : {}),
  );
}

/** Insert one document row carrying a source_id. */
async function seedDoc(id: string, path: string, title: string, source: string) {
  await storage.engine().query(
    `INSERT INTO documents (id, source_path, title, source_id) VALUES ($1, $2, $3, $4)`,
    [id, path, title, source],
  );
}

/** Insert one chunk (line range + qualified symbol optional for code reads). */
async function seedChunk(
  id: string,
  docId: string,
  idx: number,
  content: string,
  startLine: number | null = null,
  endLine: number | null = null,
  symbolQualified: string | null = null,
) {
  await storage.engine().query(
    `INSERT INTO chunks (id, document_id, chunk_index, content, start_line, end_line, symbol_name_qualified)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, docId, idx, content, startLine, endLine, symbolQualified],
  );
}

/** Ensure an entity row exists, then attach a mention on a chunk. */
async function seedMention(
  type: EntityType,
  name: string,
  chunkId: string,
  surfaceForm: string,
) {
  const eid = entityId(type, name);
  await storage.engine().query(
    `INSERT INTO entities (id, type, name) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
    [eid, type, name],
  );
  await storage.engine().query(
    `INSERT INTO entity_mentions (chunk_id, entity_id, surface_form) VALUES ($1, $2, $3)`,
    [chunkId, eid, surfaceForm],
  );
}

async function seedCodeEdge(
  fromChunk: string,
  fromSym: string,
  toSym: string,
  source: string,
) {
  await storage.engine().query(
    `INSERT INTO code_edges_symbol (from_chunk_id, from_symbol_qualified, to_symbol_qualified, edge_type, source_id)
     VALUES ($1, $2, $3, 'calls', $4)`,
    [fromChunk, fromSym, toSym, source],
  );
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-tenant-contract-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  await registerSource(storage.engine(), { id: A, kind: "vault", pathPrefix: "/tenant-a" });
  await registerSource(storage.engine(), { id: B, kind: "vault", pathPrefix: "/tenant-b" });

  // --- Shared entity page + per-source facts / timeline (trajectory, recall) ---
  await putPage(storage, { slug: ENTITY_SLUG, type: "person", title: "Alice Entity" });
  const fa = await addFact(storage, { entity_slug: ENTITY_SLUG, fact: A_FACT, source_id: A });
  const fb = await addFact(storage, { entity_slug: ENTITY_SLUG, fact: B_FACT, source_id: B });
  factIdA = fa.id as number;
  factIdB = fb.id as number;
  // The shared entity page is owned by 'default', so addTimelineEvent's ownership
  // guard (a scoped caller may only annotate a page its own source owns) blocks a
  // per-source append here. Seed the two events directly to build the cross-source
  // ledger this test asserts find_trajectory keeps READ-scoped.
  const seedEvent = (occurredAt: string, event: string, sourceId: string) =>
    storage.engine().query(
      `INSERT INTO timeline_events
         (slug, occurred_at, event, detail, source_label, source_chunk_id, source_id)
       VALUES ($1, $2::timestamptz, $3, '', '', NULL, $4)`,
      [ENTITY_SLUG, occurredAt, event, sourceId],
    );
  await seedEvent("2026-01-01T00:00:00Z", A_EVENT, A);
  await seedEvent("2026-01-02T00:00:00Z", B_EVENT, B);

  // --- resolve_slugs: distinct slugs, SAME title -----------------------------
  await putPage(storage, { slug: "team-a/alice", type: "person", title: SHARED_TITLE, markdown_body: A_BODY, source_id: A });
  await putPage(storage, { slug: "team-b/alice", type: "person", title: SHARED_TITLE, markdown_body: B_BODY, source_id: B });

  // --- Shared graph start + per-source outbound edges ------------------------
  await putPage(storage, { slug: GATEWAY, type: "note", title: "Gateway", markdown_body: "g", source_id: A });
  await putPage(storage, { slug: "vault-a/target", type: "note", title: "Target A", markdown_body: "ta", source_id: A });
  await putPage(storage, { slug: "vault-b/target", type: "note", title: "Target B", markdown_body: "tb", source_id: B });
  await addLink(storage, { source_slug: GATEWAY, target_slug: "vault-a/target", type: "mentions", source_id: A });
  await addLink(storage, { source_slug: GATEWAY, target_slug: "vault-b/target", type: "mentions", source_id: B });

  // --- Degree hub per tenant (find_experts / find_anomalies / salience) ------
  for (const [hub, spokes, src] of [
    ["hub-a", ["spoke-a1", "spoke-a2", "spoke-a3"], A],
    ["hub-b", ["spoke-b1", "spoke-b2", "spoke-b3"], B],
  ] as const) {
    await putPage(storage, { slug: hub, type: "note", title: hub, markdown_body: "hub", source_id: src });
    for (const s of spokes) {
      await putPage(storage, { slug: s, type: "note", title: s, markdown_body: "spoke", source_id: src });
      await addLink(storage, { source_slug: s, target_slug: hub, type: "mentions", source_id: src });
    }
  }

  // --- contradicts edge per tenant (find_contradictions) --------------------
  for (const [a1, a2, src] of [
    ["claim-a1", "claim-a2", A],
    ["claim-b1", "claim-b2", B],
  ] as const) {
    await putPage(storage, { slug: a1, type: "note", title: a1, markdown_body: "c", source_id: src });
    await putPage(storage, { slug: a2, type: "note", title: a2, markdown_body: "c", source_id: src });
    await addLink(storage, { source_slug: a1, target_slug: a2, type: "contradicts", source_id: src, allowAdHocType: true });
  }

  // --- documents / chunks / mentions (backlinks + code_* reads) -------------
  await seedDoc(DOC_A_NOTES, "/tenant-a/notes.md", "AAA Notes", A);
  await seedDoc(DOC_B_NOTES, "/tenant-b/notes.md", "BBB Notes", B);
  await seedChunk("ch-a-notes", DOC_A_NOTES, 0, `mentions [[${WIKI_NAME}]] ${A_BODY}`);
  await seedChunk("ch-b-notes", DOC_B_NOTES, 0, `mentions [[${WIKI_NAME}]] ${B_BODY}`);
  await seedMention("wikilink", WIKI_NAME, "ch-a-notes", WIKI_NAME);
  await seedMention("wikilink", WIKI_NAME, "ch-b-notes", WIKI_NAME);

  // Shared source_path + shared code symbol; distinctive callee/caller surfaces.
  await seedDoc(DOC_A_CODE, SHARED_PATH, "pay a", A);
  await seedDoc(DOC_B_CODE, SHARED_PATH, "pay b", B);
  await seedChunk("ch-a-pay", DOC_A_CODE, 0, `${CODE_SYM} calls ${A_CALLEE}`, 1, 5, CODE_SYM);
  await seedChunk("ch-b-pay", DOC_B_CODE, 0, `${CODE_SYM} calls ${B_CALLEE}`, 1, 5, CODE_SYM);
  await seedMention("code-def", CODE_SYM, "ch-a-pay", CODE_SYM);
  await seedMention("code-def", CODE_SYM, "ch-b-pay", CODE_SYM);
  await seedMention("code-ref", CODE_SYM, "ch-a-pay", CODE_SYM);
  await seedMention("code-ref", CODE_SYM, "ch-b-pay", CODE_SYM);
  await seedMention("code-caller", CODE_SYM, "ch-a-pay", A_CALLER);
  await seedMention("code-caller", CODE_SYM, "ch-b-pay", B_CALLER);
  await seedMention("code-callee", CODE_SYM, "ch-a-pay", A_CALLEE);
  await seedMention("code-callee", CODE_SYM, "ch-b-pay", B_CALLEE);

  // code_edges_symbol for the recursive walks (code_blast / code_flow).
  await seedCodeEdge("ch-a-pay", CODE_SYM, A_CALLEE, A); // flow a
  await seedCodeEdge("ch-b-pay", CODE_SYM, B_CALLEE, B); // flow b
  await seedCodeEdge("ch-a-pay", A_CALLER, CODE_SYM, A); // blast a
  await seedCodeEdge("ch-b-pay", B_CALLER, CODE_SYM, B); // blast b

  // --- synth_takes (list_takes) — scoped via source_ref → documents.source_id ---
  for (const [key, ref, claim] of [
    ["take-a", DOC_A_NOTES, A_TAKE],
    ["take-b", DOC_B_NOTES, B_TAKE],
  ] as const) {
    await storage.engine().query(
      `INSERT INTO synth_takes
         (take_key, source_ref, source_hash, prompt_version, claim_text, kind, weight, domain, status, model_id)
       VALUES ($1, $2, 'h', 'v1', $3, 'judgment', 0.5, NULL, 'queued', 'test')`,
      [key, ref, claim],
    );
  }

  // --- synth_concepts (list_concepts) — GLOBAL aggregate, no source axis -----
  for (const [slug, narrative] of [
    ["concept-aaa", "AAA_CONCEPT_narrative"],
    ["concept-bbb", "BBB_CONCEPT_narrative"],
  ] as const) {
    await storage.engine().query(
      `INSERT INTO synth_concepts (concept_slug, title, narrative, tier, atom_count, model_id)
       VALUES ($1, $1, $2, 'T3', 1, 'test')`,
      [slug, narrative],
    );
  }

  // --- search store (search tool) — shared keyword, per-tenant secret tokens --
  await indexPageIntoSearch(storage, { slug: "search-a/kanga", title: "Kanga A", markdown_body: `${KEYWORD} ${A_SEARCH}`, source_id: A }, { embedFn });
  await indexPageIntoSearch(storage, { slug: "search-b/kanga", title: "Kanga B", markdown_body: `${KEYWORD} ${B_SEARCH}`, source_id: B }, { embedFn });
});

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("contract: graph traversal reads honour source scope", () => {
  it("graph_neighbors: shared start fans out only to the in-scope target", async () => {
    const a = JSON.stringify(await call("graph_neighbors", { slug: GATEWAY }, auth(A)));
    expect(a).toContain("vault-a/target");
    expect(a).not.toContain("vault-b/target");
    const b = JSON.stringify(await call("graph_neighbors", { slug: GATEWAY }, auth(B)));
    expect(b).toContain("vault-b/target");
    expect(b).not.toContain("vault-a/target");
    const all = JSON.stringify(await call("graph_neighbors", { slug: GATEWAY }));
    expect(all).toContain("vault-a/target");
    expect(all).toContain("vault-b/target");
  });

  it("graph_query: typed edge query never crosses the source boundary", async () => {
    const a = JSON.stringify(await call("graph_query", { type: "mentions", source_slug: GATEWAY }, auth(A)));
    expect(a).toContain("vault-a/target");
    expect(a).not.toContain("vault-b/target");
    const b = JSON.stringify(await call("graph_query", { type: "mentions", source_slug: GATEWAY }, auth(B)));
    expect(b).not.toContain("vault-a/target");
  });

  it("traverse_graph: the walk stays inside the caller's source", async () => {
    const a = JSON.stringify(await call("traverse_graph", { start_slug: GATEWAY, direction: "outbound", max_depth: 3 }, auth(A)));
    expect(a).toContain("vault-a/target");
    expect(a).not.toContain("vault-b/target");
    const b = JSON.stringify(await call("traverse_graph", { start_slug: GATEWAY, direction: "outbound", max_depth: 3 }, auth(B)));
    expect(b).not.toContain("vault-a/target");
  });

  it("get_links: the shared start's edges split by source", async () => {
    const a = JSON.stringify(await call("get_links", { slug: GATEWAY }, auth(A)));
    expect(a).toContain("vault-a/target");
    expect(a).not.toContain("vault-b/target");
    const b = JSON.stringify(await call("get_links", { slug: GATEWAY }, auth(B)));
    expect(b).not.toContain("vault-a/target");
  });

  it("list_link_sources: per-type counts reflect only the caller's edges", async () => {
    const countFor = (rows: any[], type: string) => rows.find((r) => r.type === type)?.count ?? 0;
    const a = (await call("list_link_sources", {}, auth(A))).sources as any[];
    const b = (await call("list_link_sources", {}, auth(B))).sources as any[];
    const all = (await call("list_link_sources", {})).sources as any[];
    expect(countFor(a, "contradicts")).toBe(1);
    expect(countFor(b, "contradicts")).toBe(1);
    expect(countFor(all, "contradicts")).toBe(2);
  });
});

describe("contract: insight reads honour source scope", () => {
  it("find_experts: the hub ranks only inside its own source", async () => {
    const a = JSON.stringify(await call("find_experts", { limit: 5 }, auth(A)));
    expect(a).toContain("hub-a");
    expect(a).not.toContain("hub-b");
    const b = JSON.stringify(await call("find_experts", { limit: 5 }, auth(B)));
    expect(b).toContain("hub-b");
    expect(b).not.toContain("hub-a");
  });

  it("find_contradictions: a scoped caller sees only its own conflict pair", async () => {
    const a = JSON.stringify(await call("find_contradictions", {}, auth(A)));
    expect(a).toContain("claim-a1");
    expect(a).not.toContain("claim-b1");
    const b = JSON.stringify(await call("find_contradictions", {}, auth(B)));
    expect(b).not.toContain("claim-a1");
  });

  it("find_trajectory: the merged ledger stays source-scoped", async () => {
    const a = JSON.stringify(await call("find_trajectory", { entity_slug: ENTITY_SLUG }, auth(A)));
    expect(a).toContain(A_FACT);
    expect(a).toContain(A_EVENT);
    expect(a).not.toContain(B_FACT);
    expect(a).not.toContain(B_EVENT);
    const b = JSON.stringify(await call("find_trajectory", { entity_slug: ENTITY_SLUG }, auth(B)));
    expect(b).toContain(B_FACT);
    expect(b).not.toContain(A_FACT);
  });

  it("get_recent_salience: only the caller's pages surface", async () => {
    const a = JSON.stringify(await call("get_recent_salience", { limit: 100 }, auth(A)));
    expect(a).toContain("hub-a");
    expect(a).not.toContain("hub-b");
    const b = JSON.stringify(await call("get_recent_salience", { limit: 100 }, auth(B)));
    expect(b).not.toContain("hub-a");
  });

  it("find_anomalies: a degree hub is an outlier only within its own source", async () => {
    // sigma:1 makes the degree-3 hub a reliable outlier against its many
    // degree-0/1 in-scope peers; the cross-tenant hub must never appear.
    const a = JSON.stringify(await call("find_anomalies", { sigma: 1, limit: 50 }, auth(A)));
    expect(a).toContain("hub-a");
    expect(a).not.toContain("hub-b");
    const b = JSON.stringify(await call("find_anomalies", { sigma: 1, limit: 50 }, auth(B)));
    expect(b).not.toContain("hub-a");
  });
});

describe("contract: facts + resolution reads honour source scope", () => {
  it("recall: a fact id resolves only for its owning source", async () => {
    const aOwn = await call("recall", { id: factIdA }, auth(A));
    expect(JSON.stringify(aOwn)).toContain(A_FACT);
    // B recalling A's fact id → not_found envelope (isError), never A's text.
    const bLeak = await dispatchTool(storage, { name: "recall", arguments: { id: factIdA } }, { authInfo: auth(B) });
    expect(bLeak.isError).toBe(true);
    expect(bLeak.content[0]?.text ?? "").not.toContain(A_FACT);
    // Symmetric: A cannot recall B's fact id.
    const aLeak = await dispatchTool(storage, { name: "recall", arguments: { id: factIdB } }, { authInfo: auth(A) });
    expect(aLeak.isError).toBe(true);
    expect(aLeak.content[0]?.text ?? "").not.toContain(B_FACT);
  });

  it("resolve_slugs: a shared title resolves only to the in-scope page", async () => {
    const a = JSON.stringify(await call("resolve_slugs", { query: SHARED_TITLE }, auth(A)));
    expect(a).toContain("team-a/alice");
    expect(a).not.toContain("team-b/alice");
    const b = JSON.stringify(await call("resolve_slugs", { query: SHARED_TITLE }, auth(B)));
    expect(b).toContain("team-b/alice");
    expect(b).not.toContain("team-a/alice");
  });

  it("backlinks: a shared wikilink resolves only to the caller's document", async () => {
    const a = await call("backlinks", { name: WIKI_NAME }, auth(A));
    const aHits = a.hits as any[];
    expect(aHits.every((h) => h.documentId === DOC_A_NOTES)).toBe(true);
    expect(aHits.some((h) => h.documentId === DOC_A_NOTES)).toBe(true);
    expect(JSON.stringify(a)).not.toContain(DOC_B_NOTES);
    const b = await call("backlinks", { name: WIKI_NAME }, auth(B));
    expect((b.hits as any[]).every((h) => h.documentId === DOC_B_NOTES)).toBe(true);
    const all = await call("backlinks", { name: WIKI_NAME });
    const allDocs = (all.hits as any[]).map((h) => h.documentId);
    expect(allDocs).toContain(DOC_A_NOTES);
    expect(allDocs).toContain(DOC_B_NOTES);
  });
});

describe("contract: code-graph reads honour source scope", () => {
  it("code_def: the shared symbol resolves only to the caller's document", async () => {
    const a = await call("code_def", { name: CODE_SYM }, auth(A));
    expect((a.mentions as any[]).every((m) => m.document_id === DOC_A_CODE)).toBe(true);
    expect(JSON.stringify(a)).not.toContain(DOC_B_CODE);
    const b = await call("code_def", { name: CODE_SYM }, auth(B));
    expect((b.mentions as any[]).every((m) => m.document_id === DOC_B_CODE)).toBe(true);
  });

  it("code_refs: references stay inside the caller's source", async () => {
    const a = await call("code_refs", { name: CODE_SYM }, auth(A));
    expect((a.mentions as any[]).every((m) => m.document_id === DOC_A_CODE)).toBe(true);
    expect(JSON.stringify(a)).not.toContain(DOC_B_CODE);
  });

  it("code_callers: caller surfaces never cross the source boundary", async () => {
    const a = JSON.stringify(await call("code_callers", { name: CODE_SYM }, auth(A)));
    expect(a).toContain(A_CALLER);
    expect(a).not.toContain(B_CALLER);
    const b = JSON.stringify(await call("code_callers", { name: CODE_SYM }, auth(B)));
    expect(b).toContain(B_CALLER);
    expect(b).not.toContain(A_CALLER);
  });

  it("code_callees: the shared path:line resolves only the caller's callees", async () => {
    const a = JSON.stringify(await call("code_callees", { target: `${SHARED_PATH}:2` }, auth(A)));
    expect(a).toContain(A_CALLEE);
    expect(a).not.toContain(B_CALLEE);
    const b = JSON.stringify(await call("code_callees", { target: `${SHARED_PATH}:2` }, auth(B)));
    expect(b).toContain(B_CALLEE);
    expect(b).not.toContain(A_CALLEE);
  });

  it("code_flow: the callee walk stays inside the caller's source", async () => {
    const a = JSON.stringify(await call("code_flow", { symbol: CODE_SYM, exact: true }, auth(A)));
    expect(a).toContain(A_CALLEE);
    expect(a).not.toContain(B_CALLEE);
    const b = JSON.stringify(await call("code_flow", { symbol: CODE_SYM, exact: true }, auth(B)));
    expect(b).not.toContain(A_CALLEE);
  });

  it("code_blast: the caller walk stays inside the caller's source", async () => {
    const a = JSON.stringify(await call("code_blast", { symbol: CODE_SYM, exact: true }, auth(A)));
    expect(a).toContain(A_CALLER);
    expect(a).not.toContain(B_CALLER);
    const b = JSON.stringify(await call("code_blast", { symbol: CODE_SYM, exact: true }, auth(B)));
    expect(b).not.toContain(A_CALLER);
  });
});

describe("contract: synthesis reads + search + identity", () => {
  it("list_takes: takes scope to the caller via source_ref→document", async () => {
    const a = JSON.stringify(await call("list_takes", {}, auth(A)));
    expect(a).toContain(A_TAKE);
    expect(a).not.toContain(B_TAKE);
    const b = JSON.stringify(await call("list_takes", {}, auth(B)));
    expect(b).toContain(B_TAKE);
    expect(b).not.toContain(A_TAKE);
    const all = JSON.stringify(await call("list_takes", {}));
    expect(all).toContain(A_TAKE);
    expect(all).toContain(B_TAKE);
  });

  it("list_concepts: operator-only — a tenant token is denied, operator sees the global set", async () => {
    // synth_concepts is a GLOBAL aggregate with no source_id axis
    // (migrations/045_synthesis.sql) — concepts cluster atoms across every source.
    // Rather than leak that cross-tenant set to a scoped caller, list_concepts is
    // operator-only (v1.79.2): a tenant token is refused; the unscoped operator
    // path sees the whole-brain set.
    const a = JSON.stringify(await call("list_concepts", {}, auth(A)));
    expect(a).toContain("permission_denied");
    const all = JSON.stringify(await call("list_concepts", {}));
    expect(all).toContain("AAA_CONCEPT_narrative");
    expect(all).toContain("BBB_CONCEPT_narrative");
  });

  it("search (hybridSearch core): the search store hydrates only in-scope chunks", async () => {
    // Search-store scope via the deterministic embedder seam (no Bedrock),
    // matching the established hermetic pattern for search isolation.
    const a = JSON.stringify(await hybridSearch(storage, KEYWORD, { k: 10, sourceIds: [A], embedQuery: embedFn }));
    expect(a).toContain(A_SEARCH);
    expect(a).not.toContain(B_SEARCH);
    const b = JSON.stringify(await hybridSearch(storage, KEYWORD, { k: 10, sourceIds: [B], embedQuery: embedFn }));
    expect(b).toContain(B_SEARCH);
    expect(b).not.toContain(A_SEARCH);
    const all = JSON.stringify(await hybridSearch(storage, KEYWORD, { k: 10, embedQuery: embedFn }));
    expect(all).toContain(A_SEARCH);
    expect(all).toContain(B_SEARCH);
  });

  it("whoami: read scope reflects the caller's grant; unscoped is whole-brain", async () => {
    const a = await call("whoami", {}, auth(A));
    expect(a.read_sources).toEqual([A]);
    expect(a.write_source).toBe(A);
    const unscoped = await call("whoami", {});
    expect(unscoped.read_sources).toBeNull();
  });
});
