/**
 * Entity facts + entityRecall aggregator tests (Phase A.3).
 *
 * Covers append-only ledger, dedup on (entity_slug, fact,
 * source_chunk_id), confidence range, recency vs confidence
 * ordering, source filter, soft-stub entities (facts allowed
 * without a page), and the combined entityRecall result.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { putPage } from "../src/core/pages.ts";
import { addTimelineEvent } from "../src/core/timeline.ts";
import {
  addFact,
  entityRecall,
  listFacts,
} from "../src/core/facts.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-facts-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// addFact
// ---------------------------------------------------------------------------

describe("addFact", () => {
  it("inserts a fact about an entity that has no page yet (soft ref)", async () => {
    const r = await addFact(storage, {
      entity_slug: "people/ghost",
      fact: "Recurring email signer at conferences",
      confidence: 0.7,
    });
    expect(r.inserted).toBe(true);
  });

  it("rejects empty fact", async () => {
    await expect(
      addFact(storage, { entity_slug: "x", fact: "" }),
    ).rejects.toThrow(/non-empty/);
  });

  it("rejects out-of-range confidence", async () => {
    await expect(
      addFact(storage, { entity_slug: "x", fact: "y", confidence: 1.5 }),
    ).rejects.toThrow(/\[0, 1\]/);
  });

  it("rejects bad source_slug grammar", async () => {
    await expect(
      addFact(storage, {
        entity_slug: "x",
        fact: "y",
        source_slug: "Bad Slug",
      }),
    ).rejects.toThrow(/kebab-case/);
  });

  it("dedup on (entity_slug, fact, source_chunk_id) with chunk_id", async () => {
    const a = await addFact(storage, {
      entity_slug: "people/alice",
      fact: "ex-CFO at Acme",
      source_chunk_id: "chunk-1",
    });
    const b = await addFact(storage, {
      entity_slug: "people/alice",
      fact: "ex-CFO at Acme",
      source_chunk_id: "chunk-1",
    });
    expect(a.inserted).toBe(true);
    expect(b.inserted).toBe(false);
  });

  it("manual entries (no chunk_id) skip dedup", async () => {
    await addFact(storage, {
      entity_slug: "people/alice",
      fact: "ex-CFO at Acme",
    });
    const second = await addFact(storage, {
      entity_slug: "people/alice",
      fact: "ex-CFO at Acme",
    });
    expect(second.inserted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// listFacts
// ---------------------------------------------------------------------------

describe("listFacts", () => {
  beforeEach(async () => {
    for (const [fact, conf] of [
      ["ex-CFO at Acme", 0.95],
      ["lives in Berlin", 0.6],
      ["speaks English fluently", 0.9],
    ] as const) {
      await addFact(storage, {
        entity_slug: "people/alice",
        fact,
        confidence: conf,
      });
    }
  });

  it("orders by confidence DESC by default", async () => {
    const r = await listFacts(storage, "people/alice");
    expect(r.length).toBe(3);
    expect(r[0]!.confidence).toBeGreaterThanOrEqual(r[1]!.confidence);
    expect(r[1]!.confidence).toBeGreaterThanOrEqual(r[2]!.confidence);
    expect(r[0]!.fact).toBe("ex-CFO at Acme");
  });

  it("orders by recency when requested", async () => {
    const r = await listFacts(storage, "people/alice", { order: "recency" });
    expect(r.length).toBe(3);
    // Newest-first means the last-inserted fact is first.
    expect(r[0]!.fact).toBe("speaks English fluently");
  });

  it("filters by source_slug", async () => {
    await putPage(storage, { slug: "email/x", type: "email" });
    await addFact(storage, {
      entity_slug: "people/alice",
      fact: "from email",
      source_slug: "email/x",
    });
    const r = await listFacts(storage, "people/alice", {
      source_slug: "email/x",
    });
    expect(r.length).toBe(1);
    expect(r[0]!.fact).toBe("from email");
  });

  it("respects limit", async () => {
    const r = await listFacts(storage, "people/alice", { limit: 1 });
    expect(r.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// entityRecall — combined page + facts + timeline
// ---------------------------------------------------------------------------

describe("entityRecall", () => {
  it("returns page=null when entity is a soft-stub", async () => {
    await addFact(storage, {
      entity_slug: "people/ghost",
      fact: "first observation",
    });
    const r = await entityRecall(storage, "people/ghost");
    expect(r.page).toBeNull();
    expect(r.facts.length).toBe(1);
    expect(r.timeline).toEqual([]);
  });

  it("combines page + top facts + recent timeline when all exist", async () => {
    await putPage(storage, {
      slug: "people/alice",
      type: "person",
      title: "Alice",
      compiled_truth: { tier: 1 },
      markdown_body: "Senior person.",
    });
    await addFact(storage, {
      entity_slug: "people/alice",
      fact: "ex-CFO at Acme",
      confidence: 0.95,
    });
    await addFact(storage, {
      entity_slug: "people/alice",
      fact: "lives in Berlin",
      confidence: 0.6,
    });
    await addTimelineEvent(storage, {
      slug: "people/alice",
      occurred_at: "2024-03-10",
      event: "Promoted to CFO",
    });
    const r = await entityRecall(storage, "people/alice");
    expect(r.page).not.toBeNull();
    expect(r.page!.title).toBe("Alice");
    expect(r.facts.length).toBe(2);
    expect(r.facts[0]!.confidence).toBeGreaterThan(r.facts[1]!.confidence);
    expect(r.timeline.length).toBe(1);
    expect(r.timeline[0]!.event).toMatch(/Promoted/);
  });

  it("respects fact_limit and timeline_limit", async () => {
    await putPage(storage, { slug: "people/alice", type: "person" });
    for (let i = 0; i < 5; i++) {
      await addFact(storage, {
        entity_slug: "people/alice",
        fact: `fact ${i}`,
        confidence: 0.5 + i * 0.05,
      });
    }
    for (let i = 0; i < 5; i++) {
      await addTimelineEvent(storage, {
        slug: "people/alice",
        occurred_at: `2020-0${i + 1}-01`,
        event: `e${i}`,
      });
    }
    const r = await entityRecall(storage, "people/alice", {
      fact_limit: 2,
      timeline_limit: 3,
    });
    expect(r.facts.length).toBe(2);
    expect(r.timeline.length).toBe(3);
  });

  it("redact_body strips markdown_body from page when true", async () => {
    await putPage(storage, {
      slug: "people/alice",
      type: "person",
      markdown_body: "private body text",
    });
    const r = await entityRecall(storage, "people/alice", {
      redact_body: true,
    });
    expect(r.page).not.toBeNull();
    expect(r.page).not.toHaveProperty("markdown_body");
  });

  it("redact_body=false keeps body", async () => {
    await putPage(storage, {
      slug: "people/alice",
      type: "person",
      markdown_body: "internal-only text",
    });
    const r = await entityRecall(storage, "people/alice", {
      redact_body: false,
    });
    expect(r.page!.markdown_body).toBe("internal-only text");
  });
});

// ---------------------------------------------------------------------------
// listFacts — cross-entity recall (entity_slug omitted)
// ---------------------------------------------------------------------------

describe("listFacts cross-entity (no entity_slug)", () => {
  it("returns facts across all entities when slug is omitted", async () => {
    await addFact(storage, { entity_slug: "alice", fact: "alice likes tea", confidence: 0.9 });
    await addFact(storage, { entity_slug: "bob", fact: "bob likes coffee", confidence: 0.9 });
    const all = await listFacts(storage, undefined);
    const facts = all.map((f) => f.fact).sort();
    expect(facts).toContain("alice likes tea");
    expect(facts).toContain("bob likes coffee");
  });

  it("applies grep across entities without a slug", async () => {
    await addFact(storage, { entity_slug: "alice", fact: "alice likes tea", confidence: 0.9 });
    await addFact(storage, { entity_slug: "bob", fact: "bob likes coffee", confidence: 0.9 });
    const hits = await listFacts(storage, undefined, { grep: "coffee" });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.fact).toBe("bob likes coffee");
  });

  it("still scopes to a single entity when slug is given", async () => {
    await addFact(storage, { entity_slug: "alice", fact: "alice likes tea", confidence: 0.9 });
    await addFact(storage, { entity_slug: "bob", fact: "bob likes coffee", confidence: 0.9 });
    const only = await listFacts(storage, "alice");
    expect(only).toHaveLength(1);
    expect(only[0]?.fact).toBe("alice likes tea");
  });
});
