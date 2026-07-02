/**
 * Tenant WRITE-path RESOLUTION isolation — the second write-isolation batch.
 *
 * The destructive-op batch proved a scoped caller can't DELETE/UNLINK across
 * tenants. This suite proves the symmetric CONSTRUCTIVE-write holes:
 *
 *   HOLE 1 — the wikilink slug canonicalizer resolves WITHIN the writer's
 *            source, so tenant B's `[[Alice]]` never canonicalizes onto tenant
 *            A's `people/alice-smith` (a cross-tenant edge).
 *   HOLE 2 — link/tag inserts fold source_id into the conflict key (mig 059),
 *            so a per-tenant write mints its OWN row instead of overwriting /
 *            no-op'ing another tenant's identical (triple)/(slug,tag).
 *   HOLE 3 — under MEMEX_TENANT_FAIL_CLOSED=1 a scopeless authenticated public
 *            principal is rejected on writes (never defaults to 'default'), and
 *            appendPage never adopts a victim page's source.
 *   HOLE 4 — the gazetteer entry table is built from the writer's source only.
 *
 * Bedrock-free: seeds via core writers, asserts through the core fns + resolver
 * + a dispatch end-to-end. The global `pages.slug` PK still blocks two same-slug
 * ROWS, so the cross-tenant attack is "B references a slug that only A owns".
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { putPage, getPage, appendPage } from "../src/core/pages.ts";
import { addLink, syncWikilinksForPage } from "../src/core/links.ts";
import { addTag, getTags } from "../src/core/tags.ts";
import { makeSlugResolver } from "../src/core/slug-canonicalize.ts";
import { buildGazetteer } from "../src/core/gazetteer.ts";
import { registerSource } from "../src/core/sources.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";
import type { AuthInfo } from "../src/core/auth-info.ts";

const A = "tenanta";
const B = "tenantb";

let tmp: string;
let storage: Storage;

function auth(sourceId: string | undefined, isPublic: boolean): AuthInfo {
  return {
    token: `tok-${sourceId ?? "none"}`,
    clientId: `client-${sourceId ?? "none"}`,
    scopes: ["read", "write"],
    ...(sourceId ? { sourceId, allowedSources: [sourceId] } : { allowedSources: [] }),
    isPublic,
  };
}

async function linkRows(source_slug: string, target_slug: string, type: string) {
  const r = await storage.engine().query<{ source_id: string }>(
    `SELECT source_id FROM links
      WHERE source_slug = $1 AND target_slug = $2 AND type = $3
      ORDER BY source_id`,
    [source_slug, target_slug, type],
  );
  return r.rows.map((x) => x.source_id);
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-write-res-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  const e = storage.engine();
  await registerSource(e, { id: A, kind: "vault", pathPrefix: "/a" });
  await registerSource(e, { id: B, kind: "vault", pathPrefix: "/b" });
  // A owns the only `people/alice-smith` entity page (global slug PK).
  await putPage(storage, {
    slug: "people/alice-smith",
    type: "person",
    title: "Alice Smith",
    markdown_body: "alice",
    source_id: A,
  });
}, 60_000);

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
}, 60_000);

describe("HOLE 1 — wikilink canonicalizer resolves within the writer's source", () => {
  it("a B-scoped resolver never reaches A's people/alice-smith via prefix", async () => {
    // Unscoped (local/CLI): the prefix stage expands `Alice` → people/alice-smith.
    const whole = await makeSlugResolver(storage, "journal/b-note").resolve("Alice");
    expect(whole.slug).toBe("people/alice-smith");
    expect(whole.resolved).toBe(true);
    expect(whole.stage).toBe("prefix");

    // Scoped to B (no such page in B): falls through every DB stage to the
    // slugify floor — the cross-tenant page is invisible.
    const scoped = await makeSlugResolver(storage, "journal/b-note", {
      sourceIds: [B],
    }).resolve("Alice");
    expect(scoped.slug).toBe("alice");
    expect(scoped.resolved).toBe(false);
    expect(scoped.stage).toBe("slugify");
  });

  it("syncWikilinksForPage under B writes the fallback edge, not A's page", async () => {
    await putPage(storage, {
      slug: "journal/b-note",
      type: "note",
      markdown_body: "Met [[Alice]] today",
      source_id: B,
    });
    await syncWikilinksForPage(storage, "journal/b-note", "Met [[Alice]] today", B);
    // The edge lands on the unqualified slugify target under B — never on A's
    // people/alice-smith.
    expect(await linkRows("journal/b-note", "alice", "wikilink")).toEqual([B]);
    expect(await linkRows("journal/b-note", "people/alice-smith", "wikilink")).toEqual([]);
  });

  it("an UNSCOPED sync still canonicalizes onto the real page (behavior-neutral)", async () => {
    await putPage(storage, {
      slug: "journal/local-note",
      type: "note",
      markdown_body: "Met [[Alice]] today",
      source_id: A,
    });
    // Unscoped resolution reaches A's page and stamps a qualified edge.
    await syncWikilinksForPage(storage, "journal/local-note", "Met [[Alice]] today");
    expect(await linkRows("journal/local-note", "people/alice-smith", "wikilink")).toEqual([
      "default",
    ]);
  });
});

describe("HOLE 2 — link/tag conflict key folds in source_id (mig 059)", () => {
  it("two tenants' identical link triple yield two OWN rows, not an overwrite", async () => {
    // FK: source_slug must reference a live page; its own source_id is
    // independent of the edge rows' source_id.
    await putPage(storage, { slug: "hub/x", type: "note", markdown_body: "hub", source_id: A });
    const a = await addLink(storage, {
      source_slug: "hub/x", target_slug: "companies/acme", type: "mentions", source_id: A,
    });
    const b = await addLink(storage, {
      source_slug: "hub/x", target_slug: "companies/acme", type: "mentions", source_id: B,
    });
    expect(a.created).toBe(true);
    expect(b.created).toBe(true); // a NEW row, not an in-place update of A's
    expect(await linkRows("hub/x", "companies/acme", "mentions")).toEqual([A, B]);
  });

  it("two tenants' identical tag yield two OWN rows, not a DO-NOTHING no-op", async () => {
    await putPage(storage, { slug: "hub/y", type: "note", markdown_body: "hub", source_id: A });
    await addTag(storage, "hub/y", "topic", A);
    await addTag(storage, "hub/y", "topic", B); // pre-059 this collided → no B row
    expect(await getTags(storage, "hub/y", [A])).toContain("topic");
    expect(await getTags(storage, "hub/y", [B])).toContain("topic");
    const rows = await storage.engine().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM tags WHERE slug = 'hub/y' AND tag = 'topic'`,
    );
    expect(rows.rows[0]!.n).toBe(2);
  });

  it("a re-add within the same source is still idempotent (own row updates)", async () => {
    const again = await addLink(storage, {
      source_slug: "hub/x", target_slug: "companies/acme", type: "mentions", source_id: B,
    });
    expect(again.created).toBe(false); // same (triple, source_id) → update in place
    expect(await linkRows("hub/x", "companies/acme", "mentions")).toEqual([A, B]);
  });
});

describe("HOLE 3 — write fail-closed + appendPage never adopts a victim source", () => {
  it("appendPage scoped to B cannot append to A's page (no source adoption)", async () => {
    await putPage(storage, { slug: "victim/page", type: "note", markdown_body: "a only", source_id: A });
    await expect(
      appendPage(storage, { slug: "victim/page", content: "\nB was here", source_id: B }),
    ).rejects.toThrow(/does not exist/);
    // A's page is untouched — never re-put under B.
    const page = await getPage(storage, "victim/page", [A]);
    expect(page?.markdown_body).toBe("a only");
    expect(page?.source_id).toBe(A);
  });

  it("appendPage unscoped still appends (behavior-neutral)", async () => {
    await putPage(storage, { slug: "plain/page", type: "note", markdown_body: "one" });
    await appendPage(storage, { slug: "plain/page", content: "two" });
    const page = await getPage(storage, "plain/page");
    expect(page?.markdown_body).toBe("one\ntwo");
    expect(page?.source_id).toBe("default");
  });

  it("MEMEX_TENANT_FAIL_CLOSED=1 rejects a scopeless public principal on a write", async () => {
    const prev = process.env["MEMEX_TENANT_FAIL_CLOSED"];
    process.env["MEMEX_TENANT_FAIL_CLOSED"] = "1";
    try {
      // Scopeless public principal → write op rejected before any handler runs.
      const res = await dispatchTool(
        storage,
        { name: "page_delete", arguments: { slug: "nope/x" } },
        { isPublic: true, authInfo: auth(undefined, true) },
      );
      expect(res.isError).toBe(true);
      expect(res.content[0]!.text).toContain("permission_denied");

      // A public principal WITH a write grant is NOT rejected (scoped no-op).
      const granted = await dispatchTool(
        storage,
        { name: "page_delete", arguments: { slug: "nope/x" } },
        { isPublic: true, authInfo: auth(B, true) },
      );
      expect(granted.isError).toBeUndefined();
      expect(JSON.parse(granted.content[0]!.text).already_deleted).toBe(true);

      // A READ op is unaffected by the write gate.
      const read = await dispatchTool(
        storage,
        { name: "stats", arguments: {} },
        { isPublic: true, authInfo: auth(undefined, true) },
      );
      expect(read.isError).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env["MEMEX_TENANT_FAIL_CLOSED"];
      else process.env["MEMEX_TENANT_FAIL_CLOSED"] = prev;
    }
  });

  it("with the flag OFF, the same scopeless principal is NOT rejected (default-neutral)", async () => {
    const res = await dispatchTool(
      storage,
      { name: "page_delete", arguments: { slug: "nope/y" } },
      { isPublic: true, authInfo: auth(undefined, true) },
    );
    expect(res.isError).toBeUndefined();
    expect(JSON.parse(res.content[0]!.text).already_deleted).toBe(true);
  });
});

describe("HOLE 4 — gazetteer entry table is built from the writer's source", () => {
  beforeAll(async () => {
    await putPage(storage, {
      slug: "people/zornak", type: "person", title: "Zornak Alpha", markdown_body: "z", source_id: A,
    });
    await putPage(storage, {
      slug: "people/quibble", type: "person", title: "Quibble Beta", markdown_body: "q", source_id: B,
    });
  }, 60_000);

  it("a B-scoped build sees only B's entities", async () => {
    const g = await buildGazetteer(storage, "journal/scan", [B]);
    const slugs = g.map((e) => e.slug);
    expect(slugs).toContain("people/quibble");
    expect(slugs).not.toContain("people/zornak");
    expect(slugs).not.toContain("people/alice-smith"); // A's seed
  });

  it("an UNSCOPED build stays whole-brain (behavior-neutral)", async () => {
    const g = await buildGazetteer(storage, "journal/scan");
    const slugs = g.map((e) => e.slug);
    expect(slugs).toContain("people/quibble");
    expect(slugs).toContain("people/zornak");
  });
});
