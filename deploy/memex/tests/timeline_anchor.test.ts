/**
 * Timeline date-anchors -- opt-in MEMEX_TIMELINE_ANCHOR=1. One synthetic
 * anchor event per firmly-dated (non-'fallback' effective_date) page that has
 * no timeline_events yet; idempotent via 'date-anchor:<slug>'.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { putPage } from "../src/core/pages.ts";
import { addTimelineEvent } from "../src/core/timeline.ts";
import {
  timelineAnchorEnabled,
  timelineAnchorPhase,
} from "../src/core/timeline-anchor.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  process.env.MEMEX_TIMELINE_ANCHOR = "1";
  tmp = mkdtempSync(join(tmpdir(), "memex-tlanchor-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});
afterEach(async () => {
  delete process.env.MEMEX_TIMELINE_ANCHOR;
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

/** Page + its search-mirror document row, with an explicit content-date
 *  provenance. No chunks/embeddings needed -- the phase reads documents only. */
async function seedPage(
  slug: string,
  title: string,
  effectiveDate: string | null,
  source: string,
): Promise<void> {
  await putPage(storage, { slug, title });
  await storage.engine().query(
    `INSERT INTO documents (id, source_path, title, effective_date, effective_date_source)
     VALUES ($1, $2, $3, $4::timestamptz, $5)`,
    [`doc_${slug.replace(/\//g, "_")}`, `page://${slug}`, title, effectiveDate, source],
  );
}

interface TLRow {
  occurred_at: string;
  event: string;
  source_chunk_id: string | null;
}
async function timelineFor(slug: string): Promise<TLRow[]> {
  const r = await storage.engine().query<TLRow>(
    `SELECT occurred_at::date::text AS occurred_at, event, source_chunk_id
       FROM timeline_events WHERE slug = $1 ORDER BY id`,
    [slug],
  );
  return r.rows;
}

describe("timelineAnchorEnabled", () => {
  it("gates on exactly '1'", () => {
    expect(timelineAnchorEnabled("1")).toBe(true);
    expect(timelineAnchorEnabled("0")).toBe(false);
    expect(timelineAnchorEnabled("")).toBe(false);
  });
});

describe("timelineAnchorPhase", () => {
  it("is a no-op when disabled", async () => {
    delete process.env.MEMEX_TIMELINE_ANCHOR;
    await seedPage("notes/dated", "Dated note", "2026-03-14", "date");
    const res = await timelineAnchorPhase(storage);
    expect(res).toEqual({ pages_scanned: 0, events_written: 0 });
    expect(await timelineFor("notes/dated")).toHaveLength(0);
  });

  it("anchors a firmly-dated page exactly once (idempotent on re-run)", async () => {
    await seedPage("notes/dated", "Dated note", "2026-03-14", "date");
    const first = await timelineAnchorPhase(storage);
    expect(first.pages_scanned).toBe(1);
    expect(first.events_written).toBe(1);

    const rows = await timelineFor("notes/dated");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      occurred_at: "2026-03-14",
      event: "Dated note",
      source_chunk_id: "date-anchor:notes/dated",
    });

    // second run: the page now HAS an event, so it is not even a candidate
    const second = await timelineAnchorPhase(storage);
    expect(second.pages_scanned).toBe(0);
    expect(second.events_written).toBe(0);
    expect(await timelineFor("notes/dated")).toHaveLength(1);
  });

  it("skips a fallback-dated page (updated_at is never an anchor)", async () => {
    await seedPage("notes/undated", "Undated note", null, "fallback");
    const res = await timelineAnchorPhase(storage);
    expect(res.pages_scanned).toBe(0);
    expect(res.events_written).toBe(0);
    expect(await timelineFor("notes/undated")).toHaveLength(0);
  });

  it("skips a dated page that already carries real timeline events", async () => {
    await seedPage("notes/busy", "Busy note", "2026-01-02", "filename");
    await addTimelineEvent(storage, {
      slug: "notes/busy",
      occurred_at: "2026-01-05",
      event: "Something real happened",
    });
    const res = await timelineAnchorPhase(storage);
    expect(res.pages_scanned).toBe(0);
    expect(res.events_written).toBe(0);
    const rows = await timelineFor("notes/busy");
    expect(rows).toHaveLength(1); // only the pre-existing event, no anchor
    expect(rows[0]!.event).toBe("Something real happened");
  });

  it("falls back to the slug when the title is empty", async () => {
    await seedPage("notes/untitled", "", "2026-02-01", "event_date");
    await timelineAnchorPhase(storage);
    const rows = await timelineFor("notes/untitled");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.event).toBe("notes/untitled");
  });
});
