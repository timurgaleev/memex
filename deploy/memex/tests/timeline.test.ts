/**
 * Timeline events — per-page append-only ledger tests (Phase A.3).
 *
 * Covers slug FK constraint, ISO + Date input normalisation,
 * idempotent dedup on (slug, occurred_at, source_chunk_id), since /
 * until / limit filters, and the manual-entry (no chunk_id) path
 * that bypasses dedup.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { putPage } from "../src/core/pages.ts";
import {
  addTimelineEvent,
  getEntityTimeline,
} from "../src/core/timeline.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-tl-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// addTimelineEvent
// ---------------------------------------------------------------------------

describe("addTimelineEvent", () => {
  it("requires the page to exist (FK)", async () => {
    await expect(
      addTimelineEvent(storage, {
        slug: "people/ghost",
        occurred_at: "2024-03-10T00:00:00Z",
        event: "x",
      }),
    ).rejects.toThrow();
  });

  it("inserts when page exists", async () => {
    await putPage(storage, { slug: "people/alice", type: "person" });
    const r = await addTimelineEvent(storage, {
      slug: "people/alice",
      occurred_at: "2024-03-10T00:00:00Z",
      event: "Joined Acme as CFO",
    });
    expect(r.inserted).toBe(true);
    expect(r.id).not.toBeNull();
  });

  it("accepts Date objects for occurred_at", async () => {
    await putPage(storage, { slug: "x", type: "note" });
    const d = new Date("2024-05-01");
    const r = await addTimelineEvent(storage, {
      slug: "x",
      occurred_at: d,
      event: "y",
    });
    expect(r.inserted).toBe(true);
    expect(r.occurred_at).toBe(d.toISOString());
  });

  it("rejects invalid date strings", async () => {
    await putPage(storage, { slug: "x", type: "note" });
    await expect(
      addTimelineEvent(storage, {
        slug: "x",
        occurred_at: "not a date",
        event: "y",
      }),
    ).rejects.toThrow(/cannot parse/);
  });

  it("dedup on (slug, occurred_at, source_chunk_id) with chunk_id", async () => {
    await putPage(storage, { slug: "x", type: "note" });
    const a = await addTimelineEvent(storage, {
      slug: "x",
      occurred_at: "2024-01-01",
      event: "thing",
      source_chunk_id: "chunk-7",
    });
    const b = await addTimelineEvent(storage, {
      slug: "x",
      occurred_at: "2024-01-01",
      event: "thing",
      source_chunk_id: "chunk-7",
    });
    expect(a.inserted).toBe(true);
    expect(b.inserted).toBe(false);
  });

  it("manual entries (no chunk_id) skip dedup", async () => {
    await putPage(storage, { slug: "x", type: "note" });
    await addTimelineEvent(storage, {
      slug: "x",
      occurred_at: "2024-01-01",
      event: "raw observation v1",
    });
    const second = await addTimelineEvent(storage, {
      slug: "x",
      occurred_at: "2024-01-01",
      event: "raw observation v1",
    });
    // Both inserted — manual entries are deliberate, no dedup.
    expect(second.inserted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getEntityTimeline
// ---------------------------------------------------------------------------

describe("getEntityTimeline", () => {
  beforeEach(async () => {
    await putPage(storage, { slug: "people/alice", type: "person" });
    for (const [d, e] of [
      ["2020-01-15", "Started at Old Corp"],
      ["2022-06-01", "Moved to Acme"],
      ["2024-03-10", "Promoted to CFO"],
    ] as const) {
      await addTimelineEvent(storage, {
        slug: "people/alice",
        occurred_at: d,
        event: e,
      });
    }
  });

  it("returns newest-first by default", async () => {
    const t = await getEntityTimeline(storage, "people/alice");
    expect(t.length).toBe(3);
    expect(t[0]!.event).toMatch(/Promoted/);
    expect(t[2]!.event).toMatch(/Old Corp/);
  });

  it("filters by since", async () => {
    const t = await getEntityTimeline(storage, "people/alice", {
      since: "2023-01-01",
    });
    expect(t.length).toBe(1);
    expect(t[0]!.event).toMatch(/Promoted/);
  });

  it("filters by until", async () => {
    const t = await getEntityTimeline(storage, "people/alice", {
      until: "2022-12-31",
    });
    expect(t.map((e) => e.event).sort()).toEqual([
      "Moved to Acme",
      "Started at Old Corp",
    ]);
  });

  it("filters by since+until window", async () => {
    const t = await getEntityTimeline(storage, "people/alice", {
      since: "2021-01-01",
      until: "2023-06-01",
    });
    expect(t.length).toBe(1);
    expect(t[0]!.event).toMatch(/Acme/);
  });

  it("respects limit", async () => {
    const t = await getEntityTimeline(storage, "people/alice", { limit: 1 });
    expect(t.length).toBe(1);
  });

  it("CASCADE: deleting page hard-removes timeline rows", async () => {
    await storage
      .engine()
      .query("DELETE FROM pages WHERE slug = $1", ["people/alice"]);
    const t = await getEntityTimeline(storage, "people/alice");
    expect(t).toEqual([]);
  });
});
