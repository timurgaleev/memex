/**
 * Entity merge (phantom-redirect) — folds a duplicate/phantom stub page onto an
 * existing canonical page: re-points facts/links/timeline/tags/aliases, soft-
 * deletes the stub, records a durable redirect. PGLite-backed.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { getPage, putPage } from "../src/core/pages.ts";
import { mergePage } from "../src/core/entity-merge.ts";
import { addLink, graphNeighbors } from "../src/core/links.ts";
import { addFact } from "../src/core/facts.ts";
import { addTimelineEvent } from "../src/core/timeline.ts";
import { addTag, getTags } from "../src/core/tags.ts";
import { resolveSlugWithAlias } from "../src/core/slug-aliases.ts";

let tmp: string;
let storage: Storage;

async function factCount(slug: string): Promise<number> {
  const r = await storage
    .engine()
    .query<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM entity_facts WHERE entity_slug = $1",
      [slug],
    );
  return r.rows[0]!.n;
}

async function timelineCount(slug: string): Promise<number> {
  const r = await storage
    .engine()
    .query<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM timeline_events WHERE slug = $1",
      [slug],
    );
  return r.rows[0]!.n;
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-merge-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("mergePage", () => {
  it("re-points facts/links/timeline/tags, soft-deletes the stub, records a redirect", async () => {
    // Canonical + duplicate stub for the same person.
    await putPage(storage, { slug: "people/alice-example", type: "person", title: "Alice", markdown_body: "canon" });
    await putPage(storage, { slug: "alice", type: "person", title: "Alice", markdown_body: "stub" });
    await putPage(storage, { slug: "companies/acme", type: "company" });

    // Substrate attached to the STUB.
    await addFact(storage, { entity_slug: "alice", fact: "ex-CFO at Acme", confidence: 0.9 });
    await addTimelineEvent(storage, { slug: "alice", occurred_at: "2024-03-10", event: "changed jobs" });
    await addLink(storage, { source_slug: "alice", target_slug: "companies/acme", type: "works_at" });
    await addLink(storage, { source_slug: "companies/acme", target_slug: "alice", type: "mentions" });
    await addTag(storage, "alice", "vip");

    const r = await mergePage(storage, "alice", "people/alice-example");
    expect(r.merged).toBe(true);

    // Facts + timeline re-pointed onto the canonical, none left on the stub.
    expect(await factCount("people/alice-example")).toBe(1);
    expect(await factCount("alice")).toBe(0);
    expect(await timelineCount("people/alice-example")).toBe(1);
    expect(await timelineCount("alice")).toBe(0);

    // Tag carried.
    expect(await getTags(storage, "people/alice-example")).toContain("vip");

    // Outbound edge carried (canonical -> acme).
    const out = await graphNeighbors(storage, "people/alice-example", { direction: "outbound" });
    expect(out.some((l) => (l as { target_slug: string }).target_slug === "companies/acme")).toBe(true);
    // Inbound edge re-pointed (acme -> canonical).
    const acmeOut = await graphNeighbors(storage, "companies/acme", { direction: "outbound" });
    expect(acmeOut.some((l) => (l as { target_slug: string }).target_slug === "people/alice-example")).toBe(true);

    // Stub soft-deleted: exact miss, but resolves through the redirect.
    const viaRedirect = await getPage(storage, "alice");
    expect(viaRedirect?.slug).toBe("people/alice-example");
    expect(await resolveSlugWithAlias(storage, "alice")).toBe("people/alice-example");

    // Redirect audit row recorded with notes='merge'.
    const alias = await storage
      .engine()
      .query<{ notes: string | null }>(
        "SELECT notes FROM slug_aliases WHERE alias_slug = $1 AND canonical_slug = $2",
        ["alice", "people/alice-example"],
      );
    expect(alias.rows[0]?.notes).toBe("merge");
  });

  it("dedups a fact present on both stub and canonical (no duplicate row)", async () => {
    await putPage(storage, { slug: "people/bob-example", type: "person" });
    await putPage(storage, { slug: "bob", type: "person" });
    // Same (fact, source_chunk_id) on both — the unique index would reject a
    // naive move; merge drops the stub duplicate first.
    await addFact(storage, { entity_slug: "people/bob-example", fact: "likes tea", source_chunk_id: "c1" });
    await addFact(storage, { entity_slug: "bob", fact: "likes tea", source_chunk_id: "c1" });
    await addFact(storage, { entity_slug: "bob", fact: "lives in Berlin", source_chunk_id: "c2" });

    const r = await mergePage(storage, "bob", "people/bob-example");
    expect(r.merged).toBe(true);
    // canonical keeps its own "likes tea" + gains the distinct "lives in Berlin".
    expect(await factCount("people/bob-example")).toBe(2);
    expect(await factCount("bob")).toBe(0);
  });

  it("is a no-op when the canonical (target) page does not exist", async () => {
    await putPage(storage, { slug: "orphan", type: "note" });
    const r = await mergePage(storage, "orphan", "people/nobody");
    expect(r.merged).toBe(false);
    expect(r.reason).toMatch(/target .* not found/);
    // Stub untouched (still live).
    expect((await getPage(storage, "orphan"))?.slug).toBe("orphan");
  });

  it("is a no-op when the stub (source) page is missing", async () => {
    await putPage(storage, { slug: "people/carol", type: "person" });
    const r = await mergePage(storage, "ghost", "people/carol");
    expect(r.merged).toBe(false);
    expect(r.reason).toMatch(/source .* not found/);
  });

  it("refuses to merge across tenants", async () => {
    // Register two tenants (pages.source_id FKs -> sources, mig047).
    await storage.engine().query(
      "INSERT INTO sources (id, kind, path_prefix) VALUES ($1, 'other', $2) ON CONFLICT (id) DO NOTHING",
      ["tenant-a", "__tenant-a__"],
    );
    await storage.engine().query(
      "INSERT INTO sources (id, kind, path_prefix) VALUES ($1, 'other', $2) ON CONFLICT (id) DO NOTHING",
      ["tenant-b", "__tenant-b__"],
    );
    await putPage(storage, { slug: "dup", type: "person", source_id: "tenant-a" });
    await putPage(storage, { slug: "people/canon", type: "person", source_id: "tenant-b" });

    // Unscoped caller: the two pages belong to different sources → refuse.
    const r1 = await mergePage(storage, "dup", "people/canon");
    expect(r1.merged).toBe(false);
    expect(r1.reason).toMatch(/different sources/);

    // Scoped caller (tenant-b) cannot even see the tenant-a stub.
    const r2 = await mergePage(storage, "dup", "people/canon", { source_id: "tenant-b" });
    expect(r2.merged).toBe(false);
    expect(r2.reason).toMatch(/source .* not found/);

    // Both pages intact under their owners.
    expect((await getPage(storage, "dup", ["tenant-a"]))?.slug).toBe("dup");
    expect((await getPage(storage, "people/canon", ["tenant-b"]))?.slug).toBe("people/canon");
  });
});
