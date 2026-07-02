/**
 * Tenant WRITE-path isolation — the destructive-op leak contract.
 *
 * READ isolation (v1.58) proved a scoped caller never SEES another tenant's
 * rows. This suite proves the symmetric write contract: a caller scoped to one
 * write source can never DELETE / REVERT / UNLINK / REMOVE-TAG / FORGET / PURGE
 * a row owned by another source — the destructive mutation matches ZERO rows
 * (a no-op), while a same-scope op affects its own, and an UNSCOPED op (the
 * local CLI / internal path) still affects the row exactly as today.
 *
 * The write scope is the caller's SINGLE write source (a scalar), NOT the
 * federated READ set: a tenant may read many sources but must only mutate
 * within its own write source.
 *
 * Bedrock-free: seeds via core writers, asserts through the core fns + a
 * dispatch end-to-end. Single shared Storage (beforeAll), per-test unique slugs
 * so tests never share mutable state. The global `pages.slug` PK still blocks
 * two same-slug ROWS, so pages use distinct per-tenant slugs (the by-slug
 * cross-tenant call is the attack); tags/links/facts prove the scope filter on
 * a row that DOES exist under the other source.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import {
  putPage,
  getPage,
  deletePage,
  restorePage,
  revertPage,
} from "../src/core/pages.ts";
import { addLink, removeLink } from "../src/core/links.ts";
import { addTag, getTags, removeTag } from "../src/core/tags.ts";
import { addFact } from "../src/core/facts.ts";
import { recallFact, forgetFact } from "../src/core/facts-recall.ts";
import { purgeDeletedPages } from "../src/core/pages-purge.ts";
import { registerSource } from "../src/core/sources.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";
import type { AuthInfo } from "../src/core/auth-info.ts";

const A = "tenanta";
const B = "tenantb";

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

async function linkCount(source_slug: string, target_slug: string, type: string): Promise<number> {
  const r = await storage.engine().query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM links
      WHERE source_slug = $1 AND target_slug = $2 AND type = $3`,
    [source_slug, target_slug, type],
  );
  return r.rows[0]?.n ?? 0;
}

async function pageRowCount(slug: string): Promise<number> {
  const r = await storage.engine().query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM pages WHERE slug = $1`,
    [slug],
  );
  return r.rows[0]?.n ?? 0;
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-write-iso-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  const e = storage.engine();
  await registerSource(e, { id: A, kind: "vault", pathPrefix: "/a" });
  await registerSource(e, { id: B, kind: "vault", pathPrefix: "/b" });
});

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("deletePage write scope", () => {
  it("a delete scoped to A cannot soft-delete B's page (no-op)", async () => {
    const slug = "del/b-guard";
    await putPage(storage, { slug, type: "note", markdown_body: "b body", source_id: B });
    const r = await deletePage(storage, slug, undefined, A);
    expect(r.already_deleted).toBe(true); // out-of-scope → matched zero rows
    expect((await getPage(storage, slug, [B]))?.deleted_at).toBeNull(); // survives
  });

  it("a delete scoped to B soft-deletes B's own page", async () => {
    const slug = "del/b-own";
    await putPage(storage, { slug, type: "note", markdown_body: "b body", source_id: B });
    const r = await deletePage(storage, slug, undefined, B);
    expect(r.already_deleted).toBe(false);
    expect(await getPage(storage, slug, [B])).toBeNull();
  });

  it("an UNSCOPED delete still soft-deletes the page (behavior-neutral)", async () => {
    const slug = "del/a-unscoped";
    await putPage(storage, { slug, type: "note", markdown_body: "a body", source_id: A });
    expect((await deletePage(storage, slug)).already_deleted).toBe(false);
    expect(await getPage(storage, slug, [A])).toBeNull();
  });
});

describe("restorePage write scope", () => {
  it("a restore scoped to A cannot undelete B's page (no-op)", async () => {
    const slug = "rest/b-guard";
    await putPage(storage, { slug, type: "note", markdown_body: "b body", source_id: B });
    await deletePage(storage, slug, undefined, B);
    expect((await restorePage(storage, slug, undefined, A)).restored).toBe(false);
    expect(await getPage(storage, slug, [B])).toBeNull(); // still deleted
  });

  it("a restore scoped to B undeletes B's own page; unscoped works too", async () => {
    const slug = "rest/b-own";
    await putPage(storage, { slug, type: "note", markdown_body: "b body", source_id: B });
    await deletePage(storage, slug, undefined, B);
    expect((await restorePage(storage, slug, undefined, B)).restored).toBe(true);
    expect(await getPage(storage, slug, [B])).not.toBeNull();
    // Behavior-neutral: unscoped restore on a re-deleted page still works.
    await deletePage(storage, slug, undefined, B);
    expect((await restorePage(storage, slug)).restored).toBe(true);
  });
});

describe("revertPage write scope", () => {
  it("a revert scoped to A cannot roll back B's page (page not found)", async () => {
    const slug = "rev/b-guard";
    await putPage(storage, { slug, type: "note", markdown_body: "v1 quixor", source_id: B });
    await putPage(storage, { slug, type: "note", markdown_body: "v2 quixor", source_id: B });
    const r = await revertPage(storage, slug, 1, undefined, A);
    expect(r.reverted).toBe(false);
    expect(r.reason).toMatch(/not found/);
    expect((await getPage(storage, slug, [B]))?.markdown_body).toBe("v2 quixor"); // unchanged
  });

  it("a revert scoped to B rolls back B's own page; unscoped works too", async () => {
    const slug = "rev/b-own";
    await putPage(storage, { slug, type: "note", markdown_body: "v1 quixor", source_id: B });
    await putPage(storage, { slug, type: "note", markdown_body: "v2 quixor", source_id: B });
    expect((await revertPage(storage, slug, 1, undefined, B)).reverted).toBe(true);
    expect((await getPage(storage, slug, [B]))?.markdown_body).toBe("v1 quixor");
    // Behavior-neutral: an unscoped revert on a default page still works.
    const dslug = "rev/default";
    await putPage(storage, { slug: dslug, type: "note", markdown_body: "d1" });
    await putPage(storage, { slug: dslug, type: "note", markdown_body: "d2" });
    expect((await revertPage(storage, dslug, 1)).reverted).toBe(true);
  });
});

describe("removeLink write scope", () => {
  it("an unlink scoped to A cannot remove B's edge (0 removed)", async () => {
    const slug = "link/b-guard";
    await putPage(storage, { slug, type: "note", markdown_body: "b body", source_id: B });
    await addLink(storage, { source_slug: slug, target_slug: "companies/acme", type: "mentions", source_id: B });
    const r = await removeLink(storage, { source_slug: slug, target_slug: "companies/acme", type: "mentions", source_id: A });
    expect(r.removed).toBe(0);
    expect(await linkCount(slug, "companies/acme", "mentions")).toBe(1); // survives
  });

  it("an unlink scoped to B removes B's own edge; unscoped removes too", async () => {
    const slug = "link/b-own";
    await putPage(storage, { slug, type: "note", markdown_body: "b body", source_id: B });
    await addLink(storage, { source_slug: slug, target_slug: "companies/acme", type: "mentions", source_id: B });
    expect((await removeLink(storage, { source_slug: slug, target_slug: "companies/acme", type: "mentions", source_id: B })).removed).toBe(1);
    expect(await linkCount(slug, "companies/acme", "mentions")).toBe(0);
    // Behavior-neutral: an unscoped unlink still removes a matching edge.
    await addLink(storage, { source_slug: slug, target_slug: "companies/acme", type: "mentions", source_id: B });
    expect((await removeLink(storage, { source_slug: slug, target_slug: "companies/acme", type: "mentions" })).removed).toBe(1);
  });
});

describe("removeTag write scope", () => {
  it("a remove_tag scoped to A cannot unset B's tag (survives)", async () => {
    const slug = "tag/b-guard";
    await putPage(storage, { slug, type: "note", markdown_body: "b body", source_id: B });
    await addTag(storage, slug, "btag", B);
    await removeTag(storage, slug, "btag", A);
    expect(await getTags(storage, slug, [B])).toContain("btag"); // survives
  });

  it("a remove_tag scoped to B unsets B's own tag; unscoped works too", async () => {
    const slug = "tag/b-own";
    await putPage(storage, { slug, type: "note", markdown_body: "b body", source_id: B });
    await addTag(storage, slug, "btag", B);
    await removeTag(storage, slug, "btag", B);
    expect(await getTags(storage, slug, [B])).not.toContain("btag");
    // Behavior-neutral: an unscoped remove_tag still unsets a tag.
    await addTag(storage, slug, "btag2", B);
    await removeTag(storage, slug, "btag2");
    expect(await getTags(storage, slug, [B])).not.toContain("btag2");
  });
});

describe("forgetFact write scope", () => {
  const ENTITY = "companies/acme-facts";
  it("a forget scoped to A cannot tombstone B's fact, nor prove its existence", async () => {
    await putPage(storage, { slug: ENTITY, type: "company", markdown_body: "acme" });
    const idB = (await addFact(storage, { entity_slug: ENTITY, fact: "b-guard fact", source_id: B })).id!;
    const r = await forgetFact(storage, idB, {}, [A]);
    expect(r.found).toBe(false); // scoped probe → not yours
    expect(r.forgotten).toBe(false);
    expect(await recallFact(storage, idB)).not.toBeNull(); // B's fact survives
  });

  it("a forget scoped to B tombstones B's own fact; unscoped works too", async () => {
    const idA = (await addFact(storage, { entity_slug: ENTITY, fact: "a-own fact", source_id: A })).id!;
    const idB = (await addFact(storage, { entity_slug: ENTITY, fact: "b-own fact", source_id: B })).id!;
    expect(await forgetFact(storage, idB, {}, [B])).toEqual({ id: idB, found: true, forgotten: true });
    expect(await recallFact(storage, idB)).toBeNull();
    // Behavior-neutral: an unscoped forget still tombstones the fact.
    expect((await forgetFact(storage, idA)).forgotten).toBe(true);
  });
});

describe("purgeDeletedPages write scope", () => {
  it("a purge scoped to A reaps only A's soft-deleted rows, never B's", async () => {
    const pa = "purge/a-row";
    const pb = "purge/b-row";
    await putPage(storage, { slug: pa, type: "note", markdown_body: "a", source_id: A });
    await putPage(storage, { slug: pb, type: "note", markdown_body: "b", source_id: B });
    await deletePage(storage, pa, undefined, A);
    await deletePage(storage, pb, undefined, B);
    const r = await purgeDeletedPages(storage.engine(), 0, [A]);
    expect(r.slugs).toContain(pa);
    expect(r.slugs).not.toContain(pb);
    expect(await pageRowCount(pa)).toBe(0); // A's row hard-deleted
    expect(await pageRowCount(pb)).toBe(1); // B's row survives
  });

  it("an UNSCOPED purge reaps every aged soft-deleted row (behavior-neutral)", async () => {
    const pb = "purge/b-unscoped";
    await putPage(storage, { slug: pb, type: "note", markdown_body: "b", source_id: B });
    await deletePage(storage, pb, undefined, B);
    const r = await purgeDeletedPages(storage.engine(), 0);
    expect(r.slugs).toContain(pb);
    expect(await pageRowCount(pb)).toBe(0);
  });
});

describe("dispatch end-to-end: writeSource threads from authInfo", () => {
  it("page_delete via a B-scoped bearer cannot delete A's page", async () => {
    const slug = "e2e/a-page";
    await putPage(storage, { slug, type: "note", markdown_body: "a body", source_id: A });
    // B-scoped caller targeting A's slug → no-op (already_deleted).
    const res = await dispatchTool(storage, { name: "page_delete", arguments: { slug } }, { authInfo: auth(B) });
    expect(JSON.parse(res.content[0]!.text).already_deleted).toBe(true);
    expect((await getPage(storage, slug, [A]))?.deleted_at).toBeNull(); // survives
    // A-scoped caller deletes its own page.
    const res2 = await dispatchTool(storage, { name: "page_delete", arguments: { slug } }, { authInfo: auth(A) });
    expect(JSON.parse(res2.content[0]!.text).already_deleted).toBe(false);
  });

  it("remove_tag via a B-scoped bearer cannot unset A's tag", async () => {
    const slug = "e2e/a-tagged";
    await putPage(storage, { slug, type: "note", markdown_body: "a body", source_id: A });
    await addTag(storage, slug, "atag", A);
    await dispatchTool(storage, { name: "remove_tag", arguments: { slug, tag: "atag" } }, { authInfo: auth(B) });
    expect(await getTags(storage, slug, [A])).toContain("atag"); // survives
  });
});
