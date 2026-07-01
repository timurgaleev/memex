/**
 * Composite (source_id, slug) page-identity PRECURSOR proof.
 *
 * Two tenants must eventually each own the SAME slug. This suite proves the
 * CODE is source-aware AHEAD of the (deferred, operator-gated) PK swap that
 * drops the global `pages.slug` PRIMARY KEY. Nothing here changes a PK.
 *
 * PROVEN-READY (works today, no schema change):
 *   - The page→search mirror id is collision-free per tenant: two tenants'
 *     same-slug pages mirror to DISTINCT search documents. This works at the
 *     `documents` layer NOW because documents carry no global-slug constraint —
 *     it is exactly the mirror-id collision the composite PK would otherwise
 *     surface. This is the core fix.
 *   - The 'default' tenant's mirror id is UNCHANGED (`page://<slug>`), so the
 *     existing live mirror documents are NOT orphaned by the new scheme.
 *   - Source-scoped page / version / graph reads apply the source axis, so a
 *     scoped read never crosses tenants.
 *
 * DEFERRED to the PK-drop batch (asserted here as the KNOWN GATE):
 *   - `pages` still has the global `slug` PRIMARY KEY, so two page ROWS with the
 *     same slug cannot coexist yet. `putPage` refuses a cross-source same-slug
 *     write ("owned by another source"), and the underlying DB slug PK is the
 *     deeper physical blocker. Same-slug two-ROW reads therefore wait on the PK
 *     swap — but the read-scoping MECHANISM is proven with distinct slugs below.
 *
 * Hermetic: PGLite-backed Storage, deterministic embedder (no Bedrock).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { getPage, pageVersions, putPage } from "../src/core/pages.ts";
import { addLink, graphNeighbors } from "../src/core/links.ts";
import {
  indexPageIntoSearch,
  pageSourcePath,
} from "../src/core/page-index.ts";
import { keywordSearch } from "../src/core/search/keyword.ts";
import { deterministicEmbed } from "./det-embed.ts";

const embedFn = async (text: string) => deterministicEmbed(text);
const TENANT_B = "tenantb";

let tmp: string;
let storage: Storage;

/** The mirror document id (documents.id) for a given (slug, source) mirror. */
async function mirrorDocId(
  slug: string,
  sourceId?: string,
): Promise<string | null> {
  const r = await storage
    .engine()
    .query<{ id: string }>("SELECT id FROM documents WHERE source_path = $1", [
      pageSourcePath(slug, sourceId),
    ]);
  return r.rows[0]?.id ?? null;
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-composite-pk-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  // A second tenant. documents.source_id / pages.source_id both FK -> sources.
  await storage
    .engine()
    .query(
      "INSERT INTO sources (id, kind, path_prefix) VALUES ($1, 'other', $2) " +
        "ON CONFLICT (id) DO NOTHING",
      [TENANT_B, `__${TENANT_B}__`],
    );
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("composite-PK precursor — mirror id is tenant-aware (core fix)", () => {
  it("two tenants' same-slug pages mirror to DISTINCT search documents", async () => {
    const slug = "people/alice";
    // Same slug, two tenants, distinctive bodies. Works at the documents layer
    // TODAY — no page ROW needed, so the deferred slug-PK does not block it.
    await indexPageIntoSearch(
      storage,
      { slug, title: "Alice", markdown_body: "default alice zorbon report" },
      { embedFn },
    );
    await indexPageIntoSearch(
      storage,
      {
        slug,
        title: "Alice",
        markdown_body: "tenantb alice quixor dossier",
        source_id: TENANT_B,
      },
      { embedFn },
    );

    const defId = await mirrorDocId(slug); // page://people/alice
    const bId = await mirrorDocId(slug, TENANT_B); // page://tenantb/people/alice
    expect(defId).not.toBeNull();
    expect(bId).not.toBeNull();
    // The collision that a shared page://<slug> id would have caused is gone.
    expect(defId).not.toBe(bId);

    // Each tenant's body is searchable on ITS OWN mirror, not the other's.
    const zorbon = await keywordSearch(storage.engine(), "zorbon", 10);
    expect(zorbon.some((id) => id.startsWith(defId!))).toBe(true);
    expect(zorbon.some((id) => id.startsWith(bId!))).toBe(false);

    const quixor = await keywordSearch(storage.engine(), "quixor", 10);
    expect(quixor.some((id) => id.startsWith(bId!))).toBe(true);
    expect(quixor.some((id) => id.startsWith(defId!))).toBe(false);
  });

  it("the 'default' mirror id is UNCHANGED (back-compat, no orphaned mirrors)", () => {
    const slug = "people/alice";
    // The legacy, DB-persisted form for the single-tenant corpus.
    expect(pageSourcePath(slug)).toBe("page://people/alice");
    expect(pageSourcePath(slug, "default")).toBe("page://people/alice");
    // Only a non-'default' tenant gets the collision-free prefixed form.
    expect(pageSourcePath(slug, TENANT_B)).toBe("page://tenantb/people/alice");
  });

  it("a default-tenant page keeps its exact legacy mirror source_path", async () => {
    const slug = "notes/legacy";
    await indexPageIntoSearch(
      storage,
      { slug, title: "Legacy", markdown_body: "unchanged legacy mirror id" },
      { embedFn },
    );
    const r = await storage
      .engine()
      .query<{ n: number }>(
        "SELECT COUNT(*)::int AS n FROM documents WHERE source_path = $1",
        ["page://notes/legacy"],
      );
    expect(r.rows[0]!.n).toBe(1);
  });
});

describe("composite-PK precursor — scoped reads apply the source axis", () => {
  // The slug PK blocks two same-slug page ROWS today, so the read-scoping
  // MECHANISM is proven with distinct per-tenant slugs: a scoped read must
  // never surface a row owned by another source.
  it("getPage confines to the caller's source", async () => {
    await putPage(storage, {
      slug: "people/alice",
      type: "person",
      markdown_body: "default alice body",
    });
    await putPage(storage, {
      slug: "people/bob",
      type: "person",
      markdown_body: "tenantb bob body",
      source_id: TENANT_B,
    });

    expect(await getPage(storage, "people/alice", [TENANT_B])).toBeNull();
    expect(await getPage(storage, "people/alice", ["default"])).not.toBeNull();
    expect(await getPage(storage, "people/bob", ["default"])).toBeNull();
    expect(await getPage(storage, "people/bob", [TENANT_B])).not.toBeNull();
  });

  it("pageVersions confines to the caller's source", async () => {
    await putPage(storage, {
      slug: "people/alice",
      type: "person",
      markdown_body: "default alice v1",
    });
    // A default page's version chain is invisible to a tenantB-scoped read.
    expect((await pageVersions(storage, "people/alice", 20, [TENANT_B])).length).toBe(
      0,
    );
    expect(
      (await pageVersions(storage, "people/alice", 20, ["default"])).length,
    ).toBeGreaterThanOrEqual(1);
  });

  it("graphNeighbors confines to the caller's source", async () => {
    // links.source_slug FK -> pages.slug, so the edge's source page must exist.
    await putPage(storage, {
      slug: "people/alice",
      type: "person",
      markdown_body: "default alice",
    });
    await addLink(storage, {
      source_slug: "people/alice",
      target_slug: "companies/acme",
      type: "works_at",
      source_id: "default",
    });
    // The edge is owned by 'default'; a tenantB-scoped traversal sees nothing.
    const scopedB = await graphNeighbors(storage, "people/alice", {
      sourceIds: [TENANT_B],
    });
    expect(scopedB.length).toBe(0);
    const scopedDefault = await graphNeighbors(storage, "people/alice", {
      sourceIds: ["default"],
    });
    expect(scopedDefault.length).toBeGreaterThanOrEqual(1);
  });
});

describe("composite-PK precursor — the KNOWN GATE (deferred PK drop)", () => {
  it("putPage refuses a cross-source same-slug write", async () => {
    await putPage(storage, {
      slug: "people/carol",
      type: "person",
      markdown_body: "default carol",
    });
    // App-layer gate (pages.ts) — a slug owned by another source is off-limits
    // while slug is the global identity. Lifts when the composite PK lands.
    await expect(
      putPage(storage, {
        slug: "people/carol",
        type: "person",
        markdown_body: "tenantb carol",
        source_id: TENANT_B,
      }),
    ).rejects.toThrow(/owned by another source/);
  });

  it("the global slug PRIMARY KEY physically blocks a second same-slug row", async () => {
    await putPage(storage, {
      slug: "people/dave",
      type: "person",
      markdown_body: "default dave",
    });
    // The deeper blocker under the app gate: two page ROWS with one slug cannot
    // coexist until the slug PRIMARY KEY is dropped (the deferred batch). This
    // raw insert bypasses the app gate and still fails on the PK.
    let threw = false;
    try {
      await storage
        .engine()
        .query(
          "INSERT INTO pages (slug, type, title, compiled_truth, markdown_body, " +
            "content_hash, source_id) VALUES ($1, 'person', NULL, '{}'::jsonb, $2, $3, $4)",
          ["people/dave", "tenantb dave", "deadbeef", TENANT_B],
        );
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});
