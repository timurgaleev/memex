/**
 * Life Chronicle timeline reads — day/week windows, kind filter, on-this-day,
 * last-seen (via event who[] membership + the days_ago finalizer), soft-delete
 * hiding a projection at read time, and re-projection updating in place.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { putPage, deletePage } from "../src/core/pages.ts";
import {
  getTimelineForDate,
  getOnThisDay,
  getLastSeen,
  upsertEventProjection,
} from "../src/core/chronicle.ts";
import { addTimelineEvent } from "../src/core/timeline.ts";
import { runChronicleExtract } from "../src/core/chronicle/extract-events.ts";

let tmp: string;
let storage: Storage;
const SCOPE = { sourceIds: ["default"] };

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-chron-tl-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

/** pages/timeline_events/entity_facts source_id FK to sources — provision first. */
async function ensureSource(id: string): Promise<void> {
  await storage.engine().query(
    `INSERT INTO sources (id, kind, path_prefix) VALUES ($1, 'other', $2)
     ON CONFLICT DO NOTHING`,
    [id, `tenant:${id}`],
  );
}

/** Seed a depth page + project three events across dates via a stub judge. */
async function seed(): Promise<void> {
  await putPage(storage, {
    slug: "meetings/log",
    type: "meeting",
    markdown_body: "x".repeat(120),
    compiled_truth: {},
  });
  await runChronicleExtract(storage, {
    slug: "meetings/log",
    judge: async () => ({
      events: [
        { when: "2026-01-15", who: ["people/alice"], what: "A", kind: "meeting" },
        { when: "2026-01-16", who: ["people/bob"], what: "B", kind: "call" },
        { when: "2025-01-15", who: ["people/alice"], what: "C", kind: "meeting" },
      ],
    }),
  });
}

describe("timeline reads", () => {
  it("returns a single day's events", async () => {
    await seed();
    const rows = await getTimelineForDate(storage, "2026-01-15", SCOPE);
    expect(rows.map((r) => r.summary)).toEqual(["A"]);
  });

  it("expands to the ISO week with week:true", async () => {
    await seed();
    const rows = await getTimelineForDate(storage, "2026-01-15", { ...SCOPE, week: true });
    // 2026-01-15 is a Thursday; A (15th) and B (16th) share its Mon–Sun week.
    expect(rows.map((r) => r.summary).sort()).toEqual(["A", "B"]);
  });

  it("filters by event kind", async () => {
    await seed();
    const rows = await getTimelineForDate(storage, "2026-01-15", { ...SCOPE, week: true, kind: "call" });
    expect(rows.map((r) => r.summary)).toEqual(["B"]);
  });

  it("requires an explicit source scope", async () => {
    await seed();
    await expect(
      getTimelineForDate(storage, "2026-01-15", { sourceIds: [] }),
    ).rejects.toThrow(/sourceIds scope/);
  });

  it("surfaces same month+day in prior years via on-this-day", async () => {
    await seed();
    const rows = await getOnThisDay(storage, "2026-01-15", SCOPE);
    expect(rows.map((r) => r.summary)).toEqual(["C"]);
  });
});

describe("getLastSeen", () => {
  it("resolves an entity via an event's who[] membership + days_ago", async () => {
    await seed();
    const bob = await getLastSeen(storage, "people/bob", { ...SCOPE, asof: "2026-01-20" });
    expect(bob.last_date).toBe("2026-01-16");
    expect(bob.days_ago).toBe(4);
    expect(bob.last_event_slug).toMatch(/^life\/events\/2026-01-16-/);
  });

  it("picks the most recent appearance", async () => {
    await seed();
    const alice = await getLastSeen(storage, "people/alice", SCOPE);
    expect(alice.last_date).toBe("2026-01-15");
  });

  it("returns nulls for an unseen entity", async () => {
    await seed();
    const ghost = await getLastSeen(storage, "people/ghost", SCOPE);
    expect(ghost.last_date).toBeNull();
    expect(ghost.days_ago).toBeNull();
  });
});

describe("soft-delete + re-projection", () => {
  it("hides a projection whose event page was soft-deleted", async () => {
    await seed();
    const before = await getTimelineForDate(storage, "2026-01-15", SCOPE);
    expect(before.length).toBe(1);
    await deletePage(storage, before[0]!.event_slug!);
    const after = await getTimelineForDate(storage, "2026-01-15", SCOPE);
    expect(after.length).toBe(0);
  });

  it("updates the existing row on re-projection rather than duplicating", async () => {
    await putPage(storage, { slug: "meetings/u", type: "meeting", markdown_body: "x".repeat(120) });
    await putPage(storage, {
      slug: "life/events/2026-02-02-deadbeef",
      type: "event",
      compiled_truth: { type: "event", event: { kind: "meeting", who: [], depth: "meetings/u" } },
      markdown_body: "e",
    });
    const one = await upsertEventProjection(storage, {
      depthSlug: "meetings/u", eventSlug: "life/events/2026-02-02-deadbeef",
      dateISO: "2026-02-02", summary: "v1", sourceId: "default",
    });
    const two = await upsertEventProjection(storage, {
      depthSlug: "meetings/u", eventSlug: "life/events/2026-02-02-deadbeef",
      dateISO: "2026-02-02", summary: "v2", sourceId: "default",
    });
    expect(one.projected).toBe(true);
    expect(two.projected).toBe(true);
    const rows = await getTimelineForDate(storage, "2026-02-02", SCOPE);
    expect(rows.length).toBe(1);
    expect(rows[0]!.summary).toBe("v2");
  });

  it("does not project when the depth or event page is missing/cross-tenant", async () => {
    await putPage(storage, { slug: "life/events/2026-03-03-cafef00d", type: "event", markdown_body: "e" });
    const r = await upsertEventProjection(storage, {
      depthSlug: "meetings/absent", eventSlug: "life/events/2026-03-03-cafef00d",
      dateISO: "2026-03-03", summary: "orphan", sourceId: "default",
    });
    expect(r.projected).toBe(false);
  });

  it("projects two distinct events with the same day + summary + depth", async () => {
    // Regression: distinct event pages sharing depth/day/summary must both land
    // — the per-event source_label keeps them apart under mig079's manual-dedup
    // index (otherwise the second insert trips a unique_violation and retries).
    await putPage(storage, { slug: "meetings/dedup", type: "meeting", markdown_body: "x".repeat(120) });
    const res = await runChronicleExtract(storage, {
      slug: "meetings/dedup",
      judge: async () => ({
        events: [
          { when: "2026-05-05", who: ["people/a"], what: "Standup", kind: "call" },
          { when: "2026-05-05", who: ["people/b"], what: "Standup", kind: "call" },
        ],
      }),
    });
    expect(res.events_written).toBe(2);
    const rows = await getTimelineForDate(storage, "2026-05-05", SCOPE);
    expect(rows.length).toBe(2);
    expect(new Set(rows.map((r) => r.event_slug)).size).toBe(2);
  });
});

describe("excludeDiary fence", () => {
  // A manual timeline_add can attach a row to a diary page; a remote caller
  // must not read that interiority through the timeline surfaces.
  async function seedDiaryRow(): Promise<void> {
    await putPage(storage, {
      slug: "life/diary/2026-07-01", type: "diary", markdown_body: "private interiority note",
    });
    await addTimelineEvent(storage, {
      slug: "life/diary/2026-07-01",
      occurred_at: "2026-07-01T00:00:00Z",
      event: "felt uneasy about the deal",
      source_id: "default",
    });
  }

  it("hides a diary-page timeline row when excludeDiary is set", async () => {
    await seedDiaryRow();
    const shown = await getTimelineForDate(storage, "2026-07-01", SCOPE);
    expect(shown.length).toBe(1);
    const fenced = await getTimelineForDate(storage, "2026-07-01", { ...SCOPE, excludeDiary: true });
    expect(fenced.length).toBe(0);
  });

  it("excludes a diary-page hit from getLastSeen under excludeDiary", async () => {
    await seedDiaryRow();
    const seen = await getLastSeen(storage, "life/diary/2026-07-01", SCOPE);
    expect(seen.last_date).toBe("2026-07-01");
    const fenced = await getLastSeen(storage, "life/diary/2026-07-01", { ...SCOPE, excludeDiary: true });
    expect(fenced.last_date).toBeNull();
  });
});

describe("event time + tenant safety", () => {
  it("orders same-day events by real time, not insertion order", async () => {
    await putPage(storage, { slug: "meetings/times", type: "meeting", markdown_body: "x".repeat(120) });
    await runChronicleExtract(storage, {
      slug: "meetings/times",
      judge: async () => ({
        events: [
          { when: "2026-08-01T18:00:00Z", who: [], what: "PM", kind: "call" },
          { when: "2026-08-01T09:00:00Z", who: [], what: "AM", kind: "call" },
        ],
      }),
    });
    const rows = await getTimelineForDate(storage, "2026-08-01", SCOPE);
    expect(rows.map((r) => r.summary)).toEqual(["AM", "PM"]);
  });

  it("hides a timeline row whose source_id differs from its page's source", async () => {
    await ensureSource("a");
    await ensureSource("b");
    await putPage(storage, {
      slug: "meetings/leak", type: "meeting", markdown_body: "x".repeat(120), source_id: "b",
    });
    // A row stamped source 'a' pointing at a page owned by 'b' (a mis-scoped leak).
    await storage.engine().query(
      `INSERT INTO timeline_events (slug, occurred_at, event, source_label, source_id)
       VALUES ('meetings/leak', '2026-09-09T00:00:00Z', 'leaked', 'manual', 'a')`,
    );
    const asA = await getTimelineForDate(storage, "2026-09-09", { sourceIds: ["a"] });
    const asB = await getTimelineForDate(storage, "2026-09-09", { sourceIds: ["b"] });
    expect(asA.length).toBe(0);
    expect(asB.length).toBe(0);
  });

  it("gives two tenants distinct, both-projecting event pages for identical content", async () => {
    await ensureSource("t1");
    await ensureSource("t2");
    await putPage(storage, { slug: "meetings/t1sync", type: "meeting", markdown_body: "x".repeat(120), source_id: "t1" });
    await putPage(storage, { slug: "meetings/t2sync", type: "meeting", markdown_body: "x".repeat(120), source_id: "t2" });
    const judge = async () => ({
      events: [{ when: "2026-10-10", who: ["people/x"], what: "Sync", kind: "call" }],
    });
    await runChronicleExtract(storage, { slug: "meetings/t1sync", sourceId: "t1", judge });
    await runChronicleExtract(storage, { slug: "meetings/t2sync", sourceId: "t2", judge });
    const r1 = await getTimelineForDate(storage, "2026-10-10", { sourceIds: ["t1"] });
    const r2 = await getTimelineForDate(storage, "2026-10-10", { sourceIds: ["t2"] });
    expect(r1.length).toBe(1);
    expect(r2.length).toBe(1);
    // Distinct global slugs (sourceId folded into the content hash) so the two
    // tenants never collide on pages.slug, and each projects under its own source.
    expect(r1[0]!.event_slug).not.toBe(r2[0]!.event_slug);
  });
});
