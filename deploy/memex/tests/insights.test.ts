/**
 * Graph-insight reads — findOrphans / findExperts / findContradictions /
 * findTrajectory over the pages/links/entity_facts/timeline_events graph.
 * Deterministic, LLM-free; each is a single SQL round-trip.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { putPage, deletePage } from "../src/core/pages.ts";
import { addLink } from "../src/core/links.ts";
import { addFact } from "../src/core/facts.ts";
import { addTimelineEvent } from "../src/core/timeline.ts";
import { indexPageIntoSearch } from "../src/core/page-index.ts";
import { deterministicEmbed } from "./det-embed.ts";
import {
  findOrphans,
  findExperts,
  findContradictions,
  findTrajectory,
} from "../src/core/insights.ts";

// Hermetic embedder for the topic arm — no Bedrock.
const embedFn = async (text: string) => deterministicEmbed(text);

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-insights-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("findOrphans", () => {
  it("returns pages with no inbound links", async () => {
    await putPage(storage, { slug: "people/alice", type: "person" });
    await putPage(storage, { slug: "people/bob", type: "person" });
    await putPage(storage, { slug: "people/carol", type: "person" });
    // alice → bob; carol is referenced by nobody, bob is referenced, alice is not.
    await addLink(storage, {
      source_slug: "people/alice",
      target_slug: "people/bob",
      type: "knows",
    });

    const slugs = (await findOrphans(storage)).map((o) => o.slug).sort();
    expect(slugs).toEqual(["people/alice", "people/carol"]);
  });

  it("excludes soft-deleted pages", async () => {
    await putPage(storage, { slug: "ideas/one", type: "idea" });
    await deletePage(storage, "ideas/one");
    expect((await findOrphans(storage)).map((o) => o.slug)).toEqual([]);
  });

  it("filters by page type", async () => {
    await putPage(storage, { slug: "people/dave", type: "person" });
    await putPage(storage, { slug: "ideas/two", type: "idea" });
    const out = await findOrphans(storage, { type: "idea" });
    expect(out.map((o) => o.slug)).toEqual(["ideas/two"]);
  });

  it("honours the limit", async () => {
    await putPage(storage, { slug: "n/a", type: "note" });
    await putPage(storage, { slug: "n/b", type: "note" });
    await putPage(storage, { slug: "n/c", type: "note" });
    expect((await findOrphans(storage, { limit: 2 })).length).toBe(2);
  });
});

describe("findExperts", () => {
  it("ranks pages by distinct in+out link degree", async () => {
    await putPage(storage, { slug: "people/hub", type: "person" });
    await putPage(storage, { slug: "people/x", type: "person" });
    await putPage(storage, { slug: "people/y", type: "person" });
    await putPage(storage, { slug: "people/z", type: "person" });
    // hub connects to x, y, z (degree 3); x connects only to hub (degree 1).
    await addLink(storage, { source_slug: "people/hub", target_slug: "people/x", type: "knows" });
    await addLink(storage, { source_slug: "people/hub", target_slug: "people/y", type: "knows" });
    await addLink(storage, { source_slug: "people/z", target_slug: "people/hub", type: "knows" });

    const experts = await findExperts(storage, { limit: 1 });
    expect(experts.length).toBe(1);
    expect(experts[0]!.slug).toBe("people/hub");
    expect(experts[0]!.degree).toBe(3);
  });

  it("does not count edges to nonexistent (soft-stub) targets", async () => {
    await putPage(storage, { slug: "people/spam", type: "person" });
    // 3 edges to pages that don't exist → degree 0, not 3.
    await addLink(storage, { source_slug: "people/spam", target_slug: "ghost-a", type: "knows" });
    await addLink(storage, { source_slug: "people/spam", target_slug: "ghost-b", type: "knows" });

    const expert = (await findExperts(storage)).find((e) => e.slug === "people/spam");
    expect(expert?.degree).toBe(0);
  });

  it("filters by page type", async () => {
    await putPage(storage, { slug: "people/p", type: "person" });
    await putPage(storage, { slug: "companies/c", type: "company" });
    await addLink(storage, { source_slug: "people/p", target_slug: "companies/c", type: "works_at" });
    const out = await findExperts(storage, { type: "company" });
    expect(out.map((e) => e.slug)).toEqual(["companies/c"]);
  });
});

describe("findExperts — topic mode", () => {
  // Seed two people: alice's page is about the topic, bob's is not. Mirror
  // both bodies into search (the page → search bridge) so the topic arm can
  // score them.
  async function seedTopicPeople(): Promise<void> {
    await putPage(storage, {
      slug: "people/alice",
      type: "person",
      title: "Alice",
      markdown_body:
        "Alice leads lab automation: robotic liquid handling, assay scheduling, automation pipelines.",
    });
    await putPage(storage, {
      slug: "people/bob",
      type: "person",
      title: "Bob",
      markdown_body: "Bob keeps a garden of perennials and writes about soil composting.",
    });
    await indexPageIntoSearch(
      storage,
      {
        slug: "people/alice",
        title: "Alice",
        markdown_body:
          "Alice leads lab automation: robotic liquid handling, assay scheduling, automation pipelines.",
      },
      { embedFn },
    );
    await indexPageIntoSearch(
      storage,
      {
        slug: "people/bob",
        title: "Bob",
        markdown_body: "Bob keeps a garden of perennials and writes about soil composting.",
      },
      { embedFn },
    );
  }

  it("ranks the topic-tied person first and carries a score", async () => {
    await seedTopicPeople();

    const experts = await findExperts(storage, {
      topic: "lab automation",
      embedQuery: embedFn,
    });

    expect(experts.length).toBeGreaterThanOrEqual(1);
    expect(experts[0]!.slug).toBe("people/alice");
    expect(experts[0]!.score).toBeGreaterThan(0);
    // If bob surfaced at all, he must rank below alice.
    const bob = experts.find((e) => e.slug === "people/bob");
    if (bob) expect(bob.score!).toBeLessThan(experts[0]!.score!);
  });

  it("excludes non-person/company pages from the default candidate set", async () => {
    await seedTopicPeople();
    // A note page that also mentions the topic must NOT surface as an expert.
    await putPage(storage, {
      slug: "notes/automation-memo",
      type: "note",
      title: "Automation memo",
      markdown_body: "Notes on lab automation rollout and robotic liquid handling.",
    });
    await indexPageIntoSearch(
      storage,
      {
        slug: "notes/automation-memo",
        title: "Automation memo",
        markdown_body: "Notes on lab automation rollout and robotic liquid handling.",
      },
      { embedFn },
    );

    const experts = await findExperts(storage, {
      topic: "lab automation",
      embedQuery: embedFn,
    });
    expect(experts.some((e) => e.slug === "notes/automation-memo")).toBe(false);
    expect(experts.some((e) => e.slug === "people/alice")).toBe(true);
  });

  it("keeps link-degree behaviour when topic is absent (back-compat)", async () => {
    await putPage(storage, { slug: "people/hub", type: "person" });
    await putPage(storage, { slug: "people/x", type: "person" });
    await putPage(storage, { slug: "people/y", type: "person" });
    // hub reaches two live neighbours (degree 2); x reaches only hub (degree 1).
    await addLink(storage, { source_slug: "people/hub", target_slug: "people/x", type: "knows" });
    await addLink(storage, { source_slug: "people/hub", target_slug: "people/y", type: "knows" });

    const experts = await findExperts(storage, { limit: 1 });
    expect(experts[0]!.slug).toBe("people/hub");
    expect(experts[0]!.degree).toBe(2);
    expect(experts[0]!.score).toBeUndefined();
  });
});

describe("findContradictions", () => {
  it("returns pairs joined by a `contradicts` edge with titles", async () => {
    await putPage(storage, { slug: "claims/a", type: "note", title: "Claim A" });
    await putPage(storage, { slug: "claims/b", type: "note", title: "Claim B" });
    await addLink(storage, {
      source_slug: "claims/a",
      target_slug: "claims/b",
      type: "contradicts",
    });
    // A non-contradicts edge must NOT surface.
    await addLink(storage, {
      source_slug: "claims/a",
      target_slug: "claims/b",
      type: "related_to",
    });

    const out = await findContradictions(storage);
    expect(out.length).toBe(1);
    expect(out[0]!.source_slug).toBe("claims/a");
    expect(out[0]!.target_slug).toBe("claims/b");
    expect(out[0]!.source_title).toBe("Claim A");
    expect(out[0]!.target_title).toBe("Claim B");
  });

  it("filters by slug substring on either side", async () => {
    await putPage(storage, { slug: "x/one", type: "note" });
    await putPage(storage, { slug: "y/two", type: "note" });
    await putPage(storage, { slug: "z/three", type: "note" });
    await addLink(storage, { source_slug: "x/one", target_slug: "y/two", type: "contradicts" });
    await addLink(storage, { source_slug: "z/three", target_slug: "y/two", type: "contradicts" });

    const matchSource = await findContradictions(storage, { slug: "x/" });
    expect(matchSource.map((c) => c.source_slug)).toEqual(["x/one"]);

    // "y/two" appears as target in both → both rows match.
    const matchTarget = await findContradictions(storage, { slug: "y/two" });
    expect(matchTarget.length).toBe(2);
  });

  it("returns empty when there are no contradicts edges", async () => {
    await putPage(storage, { slug: "lonely/page", type: "note" });
    expect(await findContradictions(storage)).toEqual([]);
  });
});

describe("findTrajectory", () => {
  it("merges facts and timeline events oldest-first", async () => {
    await putPage(storage, { slug: "companies/acme", type: "company" });
    await addTimelineEvent(storage, {
      slug: "companies/acme",
      occurred_at: "2024-06-01T00:00:00Z",
      event: "raised Series A",
    });
    await addFact(storage, {
      entity_slug: "companies/acme",
      fact: "headquartered in Berlin",
    });

    const points = await findTrajectory(storage, "companies/acme");
    expect(points.length).toBe(2);
    // The event is anchored at occurred_at (2024); the manual fact's valid_from
    // is NULL so it falls back to written_at (now) → event sorts first.
    expect(points[0]!.source).toBe("event");
    expect(points[0]!.text).toBe("raised Series A");
    expect(points[1]!.source).toBe("fact");
  });

  it("anchors a fact at its valid_from when set", async () => {
    await putPage(storage, { slug: "people/eve", type: "person" });
    // Write a fact with explicit metadata directly (addFact carries no
    // valid_from arg; the fence/reconcile path does).
    await storage.engine().query(
      `INSERT INTO entity_facts (entity_slug, fact, confidence, kind, valid_from)
       VALUES ($1, $2, 1.0, 'event', '2010-01-01')`,
      ["people/eve", "joined Acme"],
    );
    await addTimelineEvent(storage, {
      slug: "people/eve",
      occurred_at: "2020-01-01T00:00:00Z",
      event: "promoted to VP",
    });

    const points = await findTrajectory(storage, "people/eve");
    expect(points.map((p) => p.text)).toEqual(["joined Acme", "promoted to VP"]);
    expect(points[0]!.kind).toBe("event");
  });

  it("applies since / until bounds on the anchor date", async () => {
    await putPage(storage, { slug: "people/frank", type: "person" });
    await addTimelineEvent(storage, {
      slug: "people/frank",
      occurred_at: "2015-01-01T00:00:00Z",
      event: "early",
    });
    await addTimelineEvent(storage, {
      slug: "people/frank",
      occurred_at: "2025-01-01T00:00:00Z",
      event: "recent",
    });

    const out = await findTrajectory(storage, "people/frank", {
      since: "2020-01-01T00:00:00Z",
    });
    expect(out.map((p) => p.text)).toEqual(["recent"]);
  });

  it("honours the limit", async () => {
    await putPage(storage, { slug: "people/grace", type: "person" });
    await addTimelineEvent(storage, { slug: "people/grace", occurred_at: "2021-01-01T00:00:00Z", event: "one" });
    await addTimelineEvent(storage, { slug: "people/grace", occurred_at: "2022-01-01T00:00:00Z", event: "two" });
    expect((await findTrajectory(storage, "people/grace", { limit: 1 })).length).toBe(1);
  });
});
