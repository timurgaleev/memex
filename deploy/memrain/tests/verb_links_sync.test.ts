/**
 * syncVerbLinksForPage (migration 053) — prose verb-context typed edges written
 * with link_kind='verb_ner'. Owns only its own edge set; a same-triple explicit
 * edge coexists as a separate row under the mig086 provenance key; never
 * touches plain wikilink edges.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { putPage } from "../src/core/pages.ts";
import { syncWikilinksForPage, syncVerbLinksForPage, addLink } from "../src/core/links.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-verblinks-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  await putPage(storage, { slug: "people/alice", type: "person" });
  await putPage(storage, { slug: "companies/acme", type: "company" });
});
afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function edges(): Promise<Array<{ type: string; link_kind: string | null }>> {
  const r = await storage.engine().query<{ type: string; link_kind: string | null }>(
    "SELECT type, link_kind FROM links WHERE source_slug = 'people/alice' ORDER BY type, link_kind",
  );
  return r.rows;
}

describe("syncVerbLinksForPage", () => {
  it("writes a verb_ner typed edge when prose carries a verb", async () => {
    const body = "Alice invested in [[companies/acme]] at the seed round.";
    const r = await syncVerbLinksForPage(storage, "people/alice", "person", body);
    expect(r.added).toBe(1);
    expect(await edges()).toContainEqual({ type: "invested_in", link_kind: "verb_ner" });
  });

  it("writes nothing when no verb is present (the wikilink edge already covers it)", async () => {
    const r = await syncVerbLinksForPage(storage, "people/alice", "person", "see [[companies/acme]] for details");
    expect(r.added).toBe(0);
    expect(await edges()).toEqual([]);
  });

  it("coexists with — never deletes — the plain wikilink edge", async () => {
    const body = "Alice founded [[companies/acme]].";
    await syncWikilinksForPage(storage, "people/alice", body); // plain wikilink edge
    await syncVerbLinksForPage(storage, "people/alice", "person", body); // verb_ner founded edge
    const got = await edges();
    expect(got).toContainEqual({ type: "wikilink", link_kind: "plain" });
    expect(got).toContainEqual({ type: "founded", link_kind: "verb_ner" });
  });

  it("coexists with an explicit edge on the same (source, target, type)", async () => {
    // An explicit founded edge (link_kind NULL, link_source 'manual') exists.
    await addLink(storage, { source_slug: "people/alice", target_slug: "companies/acme", type: "founded" });
    const r = await syncVerbLinksForPage(storage, "people/alice", "person", "Alice founded [[companies/acme]].");
    // mig086: each writer owns its own row — the inferred edge lands as a
    // SEPARATE 'mentions'-provenance row instead of being swallowed, and the
    // explicit edge is untouched.
    expect(r.added).toBe(1);
    const founded = (await edges()).filter((e) => e.type === "founded");
    expect(founded).toContainEqual({ type: "founded", link_kind: null });
    expect(founded).toContainEqual({ type: "founded", link_kind: "verb_ner" });
  });

  it("is idempotent — re-sync replaces only its own verb_ner set", async () => {
    const body = "Alice invested in [[companies/acme]].";
    await syncVerbLinksForPage(storage, "people/alice", "person", body);
    const second = await syncVerbLinksForPage(storage, "people/alice", "person", body);
    expect(second.removed).toBe(1);
    expect(second.added).toBe(1);
    expect((await edges()).filter((e) => e.link_kind === "verb_ner")).toHaveLength(1);
  });

  it("types a meeting attendee as attended only from the attendance section", async () => {
    await putPage(storage, { slug: "meetings/kickoff", type: "meeting" });
    await putPage(storage, { slug: "people/bob", type: "person" });
    await putPage(storage, { slug: "people/zed", type: "person" });
    const body = "## Attendees\n- [[people/bob]] (CEO), [[people/zed]]\n\n## Notes\nWe discussed [[people/alice]].";
    await syncVerbLinksForPage(storage, "meetings/kickoff", "meeting", body);
    const r = await storage.engine().query<{ target_slug: string; type: string }>(
      "SELECT target_slug, type FROM links WHERE source_slug = 'meetings/kickoff' AND link_kind = 'verb_ner' ORDER BY target_slug",
    );
    expect(r.rows).toEqual([{ target_slug: "people/bob", type: "attended" }]);
  });

  it("does not fire the person role prior for a company named only under Timeline", async () => {
    const role = "Alice spends her days as a seed investor.\n\n";
    const listed = await syncVerbLinksForPage(storage, "people/alice", "person", `${role}## Timeline\n- 2024-01-02 | [[companies/acme]] raised a round`);
    expect(listed.added).toBe(0);
    expect(await edges()).toEqual([]);
    // The same mention in prose still takes the prior.
    const prose = await syncVerbLinksForPage(storage, "people/alice", "person", `${role}## Notes\nShe met [[companies/acme]] last week.`);
    expect(prose.added).toBe(1);
    expect(await edges()).toEqual([{ type: "invested_in", link_kind: "verb_ner" }]);
  });
});
