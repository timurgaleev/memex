/**
 * Tenant isolation — the cross-tenant leak contract.
 *
 * Two tenants ('a', 'b') write the same entity. A caller scoped to one source
 * (via DispatchOptions.authInfo) must never see the other's pages, facts,
 * timeline, or links. An unscoped caller (no authInfo — local/internal) still
 * sees everything (back-compat).
 *
 * Bedrock-free: seeds via core writers + asserts through dispatchTool, no
 * `search` (which would need embeddings). Search isolation is structural — the
 * arms filter `documents.source_id` and the page→document bridge stamps it.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
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
import { addTag } from "../src/core/tags.ts";
import { hybridSearch } from "../src/core/search/hybrid.ts";
import { applyGraphSignals, type GraphSignalScorable } from "../src/core/search/graph-signals.ts";
import { queryCacheKey, putCachedQuery } from "../src/core/search/query-cache.ts";
import { currentDocumentClock } from "../src/core/generation.ts";
import { deterministicEmbed } from "./det-embed.ts";
import type { AuthInfo } from "../src/core/auth-info.ts";

// Inject the deterministic embedder so the page→chunks bridge never calls Bedrock.
const embedFn = async (text: string) => deterministicEmbed(text);

const ENTITY = "acme";
const A_SLUG = "companies/acme-a";
const B_SLUG = "companies/acme-b";
const A_SECRET = "Tenant-A-only: revenue 4.2M";
const B_SECRET = "Tenant-B-only: revenue 9.9M";
// A-only chunk body (distinct token) so get_chunks leakage is unambiguous.
const A_CHUNK_SECRET = "TenantAChunkSecret-zebra-quartz-9417";
// Target page A's body wikilinks to, so page_put derives a wikilink edge.
const A_LINK_TARGET = "companies/acme-subsidiary-a";

// Read-surface fixtures (BATCH 3): a shared keyword ("quokka") with per-tenant
// secret tokens, mirrored into the search store so a scoped query/hydrate
// proves it filters on documents.source_id. Bedrock-free via the det-embed seam.
const QA_SLUG = "qtest/quokka-a";
const QB_SLUG = "qtest/quokka-b";
const QA_TOKEN = "AlphaSecretAAA";
const QB_TOKEN = "BetaSecretBBB";
const QA_BODY = `quokka ${QA_TOKEN}`;
const QB_BODY = `quokka ${QB_TOKEN}`;
// Distinct per-tenant tag tokens for the get_tags leak-lock.
const A_TAG = "atag-alpha";
const B_TAG = "btag-beta";

let tmp: string;
let storage: Storage;

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

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-tenant-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  const e = storage.engine();
  await registerSource(e, { id: "a", kind: "vault", pathPrefix: "/tenant-a" });
  await registerSource(e, { id: "b", kind: "vault", pathPrefix: "/tenant-b" });

  await putPage(storage, { slug: A_SLUG, type: "company", title: "Acme A", markdown_body: A_SECRET, source_id: "a" });
  await putPage(storage, { slug: B_SLUG, type: "company", title: "Acme B", markdown_body: B_SECRET, source_id: "b" });
  // Entity page needed for FK on timeline_events.slug and facts.entity_slug
  await putPage(storage, { slug: ENTITY, type: "company", title: "Acme Entity" });
  // visibility:"world" — a scoped tenant reader is floored to world-visible
  // facts (mig-085); the tenant isolation here is enforced by source_id, so the
  // facts must clear the world floor to be readable at all.
  await addFact(storage, { entity_slug: ENTITY, fact: A_SECRET, source_id: "a", visibility: "world" });
  await addFact(storage, { entity_slug: ENTITY, fact: B_SECRET, source_id: "b", visibility: "world" });
  // Timeline events go on each tenant's OWN page (ownership guard: a scoped caller
  // may only append to a page its own source owns — a tenant cannot annotate the
  // shared/default ENTITY, which would be another tenant's page).
  await addTimelineEvent(storage, { slug: A_SLUG, occurred_at: "2026-01-01T00:00:00Z", event: A_SECRET, source_id: "a" });
  await addTimelineEvent(storage, { slug: B_SLUG, occurred_at: "2026-01-02T00:00:00Z", event: B_SECRET, source_id: "b" });
  await addLink(storage, { source_slug: A_SLUG, target_slug: ENTITY, type: "mentions", source_id: "a" });
  await addLink(storage, { source_slug: B_SLUG, target_slug: ENTITY, type: "mentions", source_id: "b" });

  // get_chunks: mirror A's page body into the search store (documents+chunks),
  // exactly as the page bridge would, but offline via the det-embed seam. The
  // mirror document carries source_id "a" so a B-scoped get_chunks must not
  // see A's chunk text.
  await indexPageIntoSearch(
    storage,
    { slug: A_SLUG, title: "Acme A", markdown_body: A_CHUNK_SECRET, source_id: "a" },
    { embedFn },
  );

  // Derived-write stamping: wikilink target page (source_id "a") so A's
  // page_put can derive a resolvable wikilink edge to it.
  await putPage(storage, { slug: A_LINK_TARGET, type: "company", title: "Acme Subsidiary A", markdown_body: "sub", source_id: "a" });

  // BATCH 3 read-surface fixtures — both tenants share the "quokka" keyword so
  // retrieval surfaces both, and only the scope decides which chunk hydrates.
  await indexPageIntoSearch(storage, { slug: QA_SLUG, title: "Quokka A", markdown_body: QA_BODY, source_id: "a" }, { embedFn });
  await indexPageIntoSearch(storage, { slug: QB_SLUG, title: "Quokka B", markdown_body: QB_BODY, source_id: "b" }, { embedFn });
  // Tags stamped per-source (mig047) on each tenant's own page.
  await addTag(storage, A_SLUG, A_TAG, "a");
  await addTag(storage, B_SLUG, B_TAG, "b");
});

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

function payload(result: ToolCallResult): any {
  expect(result.content[0]?.type).toBe("text");
  return JSON.parse(result.content[0]!.text);
}

async function call(name: string, args: Record<string, unknown>, authInfo?: AuthInfo): Promise<any> {
  return payload(await dispatchTool(storage, { name, arguments: args }, authInfo ? { authInfo } : {}));
}

describe("tenant isolation via dispatch authInfo", () => {
  it("page_get: B cannot read A's page", async () => {
    const result = await dispatchTool(storage, { name: "page_get", arguments: { slug: A_SLUG } }, { authInfo: auth("b") });
    const text = result.content[0]?.text ?? "";
    expect(text).not.toContain(A_SECRET);
  });

  it("page_get: A reads its own page", async () => {
    const out = await call("page_get", { slug: A_SLUG }, auth("a"));
    expect(JSON.stringify(out)).toContain(A_SECRET);
  });

  it("page_list: each tenant sees only its own slug", async () => {
    const a = JSON.stringify(await call("page_list", {}, auth("a")));
    expect(a).toContain(A_SLUG);
    expect(a).not.toContain(B_SLUG);
    const b = JSON.stringify(await call("page_list", {}, auth("b")));
    expect(b).toContain(B_SLUG);
    expect(b).not.toContain(A_SLUG);
  });

  it("list_concepts: a tenant token is refused (operator-only — synth_concepts has no source axis)", async () => {
    // synth_concepts clusters across ALL tenants, so a tenant token must not be
    // able to read it — otherwise one tenant sees concepts derived from another's
    // notes. Gated operator-only; a tenant call is rejected before dispatch.
    const result = await dispatchTool(
      storage,
      { name: "list_concepts", arguments: {} },
      { authInfo: auth("b") },
    );
    const text = result.content[0]?.text ?? "";
    expect(text).toMatch(/operator-only|permission_denied/i);
  });

  it("entity_facts: B sees only its own fact", async () => {
    const b = JSON.stringify(await call("entity_facts", { entity_slug: ENTITY }, auth("b")));
    expect(b).toContain(B_SECRET);
    expect(b).not.toContain(A_SECRET);
  });

  it("entity_timeline: B cannot see A's event on A's page", async () => {
    // B queries A's page timeline — source-filtered reads return nothing of A's.
    const b = JSON.stringify(await call("entity_timeline", { slug: A_SLUG }, auth("b")));
    expect(b).not.toContain(A_SECRET);
    // B sees its own event on its own page.
    const bOwn = JSON.stringify(await call("entity_timeline", { slug: B_SLUG }, auth("b")));
    expect(bOwn).toContain(B_SECRET);
  });

  it("get_links: A's edges are not visible to B", async () => {
    const b = JSON.stringify(await call("get_links", { slug: B_SLUG }, auth("b")));
    expect(b).not.toContain(A_SLUG);
  });

  it("get_chunks: B cannot read A's page chunk text", async () => {
    // A's chunk is reachable to A...
    const a = JSON.stringify(await call("get_chunks", { slug: A_SLUG }, auth("a")));
    expect(a).toContain(A_CHUNK_SECRET);
    // ...but B's get_chunks for A's slug must not surface A's chunk body.
    const b = JSON.stringify(await call("get_chunks", { slug: A_SLUG }, auth("b")));
    expect(b).not.toContain(A_CHUNK_SECRET);
  });

  it("relational_recall: B does not surface A-only slugs", async () => {
    // Walks every edge touching the entity (intro archetype). A's mentions edge
    // (A_SLUG→entity) is source 'a', so a B-scoped traversal must not reach it.
    const b = JSON.stringify(
      await call("relational_recall", { query: `who introduced me to ${ENTITY}?` }, auth("b")),
    );
    expect(b).not.toContain(A_SLUG);
  });

  it("derived-write stamping: A's page_put stamps wikilink edges as source 'a' (not 'default')", async () => {
    // page_put through dispatch derives a wikilink edge from the body. With an
    // authInfo write source, the derived edge must inherit 'a' — never the
    // 'default' column default (which would make it whole-brain visible).
    await call(
      "page_put",
      { slug: A_SLUG, type: "company", title: "Acme A", markdown_body: `${A_SECRET}\n\nSee [[${A_LINK_TARGET}]].` },
      auth("a"),
    );
    // Query the links table directly to confirm the stored provenance.
    const rows = await storage.engine().query<{ source_id: string }>(
      `SELECT source_id FROM links
        WHERE source_slug = $1 AND target_slug = $2 AND type = 'wikilink'`,
      [A_SLUG, A_LINK_TARGET],
    );
    expect(rows.rows.length).toBeGreaterThan(0);
    for (const r of rows.rows) {
      expect(r.source_id).toBe("a");
      expect(r.source_id).not.toBe("default");
    }
    // And an unscoped get_links shows the derived edge under source 'a'.
    const unscoped = JSON.stringify(await call("get_links", { slug: A_SLUG }));
    expect(unscoped).toContain(A_LINK_TARGET);
  });

  it("find_orphans: B does not see A-only entities", async () => {
    // A_SLUG (source 'a') has no inbound links → it's an orphan for tenant A,
    // but must never appear in tenant B's orphan list.
    const a = JSON.stringify(await call("find_orphans", {}, auth("a")));
    expect(a).toContain(A_SLUG);
    const b = JSON.stringify(await call("find_orphans", {}, auth("b")));
    expect(b).not.toContain(A_SLUG);
  });

  it("entity_recall: B cannot read A's page body via the entity page fetch", async () => {
    // entity_recall fetches the entity's page alongside facts/timeline. The page
    // fetch must be source-scoped too, else a federated caller leaks the body.
    const b = JSON.stringify(await call("entity_recall", { slug: A_SLUG }, auth("b")));
    expect(b).not.toContain(A_SECRET);
    const a = JSON.stringify(await call("entity_recall", { slug: A_SLUG }, auth("a")));
    expect(a).toContain(A_SECRET);
  });

  it("back-compat: an unscoped caller sees both tenants", async () => {
    const all = JSON.stringify(await call("page_list", {}));
    expect(all).toContain(A_SLUG);
    expect(all).toContain(B_SLUG);
  });
});

describe("read-surface scoping (BATCH 3)", () => {
  it("get_tags: B cannot read A's tag; A sees its own; unscoped sees both", async () => {
    const b = await call("get_tags", { slug: A_SLUG }, auth("b"));
    expect(b.tags).not.toContain(A_TAG);
    const a = await call("get_tags", { slug: A_SLUG }, auth("a"));
    expect(a.tags).toContain(A_TAG);
    // Behaviour-neutral: an unscoped caller sees the tag whole-brain.
    const all = await call("get_tags", { slug: A_SLUG });
    expect(all.tags).toContain(A_TAG);
  });

  it("page_versions: B cannot read A's version snapshots; A + unscoped can", async () => {
    const b = JSON.stringify(await call("page_versions", { slug: A_SLUG }, auth("b")));
    expect(b).not.toContain(A_SECRET);
    const a = JSON.stringify(await call("page_versions", { slug: A_SLUG }, auth("a")));
    expect(a).toContain(A_SECRET);
    const all = JSON.stringify(await call("page_versions", { slug: A_SLUG }));
    expect(all).toContain(A_SECRET);
  });

  it("query tool: B-scoped refinement never surfaces A's chunk token", async () => {
    // Keyword arm only (no Bedrock in tests → embed fails → keyword fallback).
    const b = JSON.stringify(await call("query", { q: "quokka" }, auth("b")));
    expect(b).not.toContain(QA_TOKEN);
    expect(b).toContain(QB_TOKEN);
    const a = JSON.stringify(await call("query", { q: "quokka" }, auth("a")));
    expect(a).not.toContain(QB_TOKEN);
    // Behaviour-neutral: unscoped query sees both tenants' chunks.
    const all = JSON.stringify(await call("query", { q: "quokka" }));
    expect(all).toContain(QA_TOKEN);
    expect(all).toContain(QB_TOKEN);
  });

  it("hydrate: scoped hybridSearch hydrates only in-scope chunks; unscoped sees both", async () => {
    const scoped = await hybridSearch(storage, "quokka", {
      k: 10,
      sourceIds: ["a"],
      embedQuery: embedFn,
    });
    const scopedStr = JSON.stringify(scoped);
    expect(scopedStr).toContain(QA_TOKEN);
    expect(scopedStr).not.toContain(QB_TOKEN);
    const unscoped = JSON.stringify(
      await hybridSearch(storage, "quokka", { k: 10, embedQuery: embedFn }),
    );
    expect(unscoped).toContain(QA_TOKEN);
    expect(unscoped).toContain(QB_TOKEN);
  });

  it("hydrateByIds (cache arm): a stale cross-source cache row is re-filtered on hydrate", async () => {
    const engine = storage.engine();
    // Grab B's mirrored chunk (source 'b').
    const bChunk = await engine.query<{ id: string; document_id: string }>(
      `SELECT c.id, c.document_id FROM chunks c
         JOIN documents d ON d.id = c.document_id
        WHERE d.source_id = 'b' AND c.content LIKE '%' || $1 || '%' LIMIT 1`,
      [QB_TOKEN],
    );
    expect(bChunk.rows.length).toBe(1);
    const { id: bChunkId, document_id: bDocId } = bChunk.rows[0]!;

    // Poison the 'a'-scoped cache key with B's chunk id, as a re-scope could
    // strand. A scoped hydrate must still filter it out (leak-lock).
    const qLeak = "cacheprobe leak phrase alpha";
    const clockA = await currentDocumentClock(engine);
    const keyA = queryCacheKey(qLeak, 10, ["a"], false);
    await putCachedQuery(engine, keyA, qLeak, 10, "topic", [bChunkId], clockA, [bDocId]);
    const leaked = JSON.stringify(
      await hybridSearch(storage, qLeak, { k: 10, sourceIds: ["a"], rerank: false, embedQuery: embedFn }),
    );
    expect(leaked).not.toContain(QB_TOKEN);

    // Behaviour-neutral control: the SAME poisoned id under an UNSCOPED key
    // still hydrates (whole-brain), proving the guard only trims out-of-scope.
    const qNeutral = "cacheprobe neutral phrase beta";
    const clockU = await currentDocumentClock(engine);
    const keyU = queryCacheKey(qNeutral, 10, undefined, false);
    await putCachedQuery(engine, keyU, qNeutral, 10, "topic", [bChunkId], clockU, [bDocId]);
    const served = JSON.stringify(
      await hybridSearch(storage, qNeutral, { k: 10, rerank: false, embedQuery: embedFn }),
    );
    expect(served).toContain(QB_TOKEN);
  });

  it("graph-signals adjacency: a scoped caller never inherits another source's hub boost", async () => {
    const engine = storage.engine();
    // Hub with two inbound links, both stamped source 'b'. Endpoints are live
    // pages so defaultAdjacency's page joins hold.
    const HUB = "gs/hub";
    const L1 = "gs/b1";
    const L2 = "gs/b2";
    await putPage(storage, { slug: HUB, type: "note", title: "Hub", markdown_body: "hub", source_id: "b" });
    await putPage(storage, { slug: L1, type: "note", title: "L1", markdown_body: "l1", source_id: "b" });
    await putPage(storage, { slug: L2, type: "note", title: "L2", markdown_body: "l2", source_id: "b" });
    await addLink(storage, { source_slug: L1, target_slug: HUB, type: "mentions", source_id: "b" });
    await addLink(storage, { source_slug: L2, target_slug: HUB, type: "mentions", source_id: "b" });

    const mkResults = (): GraphSignalScorable[] =>
      [HUB, L1, L2].map((slug) => ({ score: 1, payload: { sourcePath: `page://${slug}` } }));

    // 'a'-scoped: the 'b' links are invisible → hub gets no adjacency boost.
    const aScoped = mkResults();
    await applyGraphSignals(aScoped, engine, { enabled: true, sourceIds: ["a"] });
    expect(aScoped[0]!.score).toBe(1);

    // 'b'-scoped: two in-source inbound links → hub boosted above its peers.
    const bScoped = mkResults();
    await applyGraphSignals(bScoped, engine, { enabled: true, sourceIds: ["b"] });
    expect(bScoped[0]!.score).toBeGreaterThan(1);

    // Behaviour-neutral: an unscoped caller sees the same hub boost as today.
    const unscoped = mkResults();
    await applyGraphSignals(unscoped, engine, { enabled: true });
    expect(unscoped[0]!.score).toBeGreaterThan(1);
  });
});
