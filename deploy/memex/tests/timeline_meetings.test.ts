/**
 * Timeline extraction from meetings -- opt-in MEMEX_MEETING_TIMELINE=1.
 * Writes append-only timeline_events for a meeting + its resolved attendees.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { putPage } from "../src/core/pages.ts";
import {
  extractMeetingTimelinePhase,
  meetingTimelineEnabled,
  resolveMeetingDate,
} from "../src/core/timeline-meetings.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  process.env.MEMEX_MEETING_TIMELINE = "1";
  tmp = mkdtempSync(join(tmpdir(), "memex-mtgtl-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});
afterEach(async () => {
  delete process.env.MEMEX_MEETING_TIMELINE;
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

interface TLRow {
  slug: string;
  occurred_at: string;
  event: string;
}
async function timelineFor(slug: string): Promise<TLRow[]> {
  const r = await storage.engine().query<TLRow>(
    `SELECT slug, occurred_at::date::text AS occurred_at, event
       FROM timeline_events WHERE slug = $1 ORDER BY event`,
    [slug],
  );
  return r.rows;
}

describe("meetingTimelineEnabled / resolveMeetingDate", () => {
  it("gates on exactly '1'", () => {
    expect(meetingTimelineEnabled("1")).toBe(true);
    expect(meetingTimelineEnabled("0")).toBe(false);
    expect(meetingTimelineEnabled("")).toBe(false);
  });

  it("resolves date from field, then slug, else null (NOT from body)", () => {
    expect(resolveMeetingDate({ date: "2026-05-18" }, "meetings/x")).toBe("2026-05-18");
    expect(resolveMeetingDate({}, "meetings/2026-05-18-standup")).toBe("2026-05-18");
    expect(resolveMeetingDate({}, "meetings/x")).toBeNull();
    // implausible explicit date is rejected, falls through to slug -> null
    expect(resolveMeetingDate({ date: "2099-99-99" }, "meetings/x")).toBeNull();
    // a non-calendar date (Feb 31) is rejected, not normalized to a wrong day
    expect(resolveMeetingDate({ date: "2026-02-31" }, "meetings/x")).toBeNull();
    // non-string explicit date is coerced
    expect(resolveMeetingDate({ date: 20260518 as unknown as string }, "m/x")).toBeNull();
  });
});

describe("extractMeetingTimelinePhase", () => {
  it("is a no-op when disabled", async () => {
    delete process.env.MEMEX_MEETING_TIMELINE;
    await putPage(storage, {
      slug: "meetings/2026-05-18-standup",
      type: "meeting",
      title: "Standup",
      compiled_truth: { attendees: ["Alice"] },
    });
    const res = await extractMeetingTimelinePhase(storage);
    expect(res).toEqual({ meetings_scanned: 0, entries_written: 0, attendees_touched: 0 });
  });

  it("writes a meeting event + an Attended event per resolved attendee", async () => {
    await putPage(storage, { slug: "people/alice", type: "person", title: "Alice" });
    await putPage(storage, { slug: "people/bob", type: "person", title: "Bob" });
    await putPage(storage, {
      slug: "meetings/2026-05-18-standup",
      type: "meeting",
      title: "Standup",
      compiled_truth: { date: "2026-05-18", attendees: ["Alice", "Bob"] },
    });
    const res = await extractMeetingTimelinePhase(storage);
    expect(res.meetings_scanned).toBe(1);
    expect(res.attendees_touched).toBe(2);
    expect(res.entries_written).toBe(3); // meeting-self + 2 attendees

    const mtg = await timelineFor("meetings/2026-05-18-standup");
    expect(mtg).toHaveLength(1);
    expect(mtg[0]).toMatchObject({ occurred_at: "2026-05-18", event: "Meeting: Standup" });

    const alice = await timelineFor("people/alice");
    expect(alice[0]).toMatchObject({ occurred_at: "2026-05-18", event: "Attended Standup" });
  });

  it("scans an undated meeting but writes nothing", async () => {
    await putPage(storage, {
      slug: "meetings/undated",
      type: "meeting",
      title: "Undated",
      compiled_truth: { attendees: ["Alice"] },
    });
    const res = await extractMeetingTimelinePhase(storage);
    expect(res.meetings_scanned).toBe(1); // scanned (then skipped on no date)
    expect(res.entries_written).toBe(0);
  });

  it("skips an attendee that does not resolve to a real page", async () => {
    await putPage(storage, {
      slug: "meetings/2026-01-01-kick",
      type: "meeting",
      title: "Kickoff",
      compiled_truth: { date: "2026-01-01", attendees: ["Ghosty McGhostface"] },
    });
    const res = await extractMeetingTimelinePhase(storage);
    expect(res.attendees_touched).toBe(0);
    expect(res.entries_written).toBe(1); // only the meeting-self event
  });

  it("re-projects without duplicating (replace-own-projection)", async () => {
    await putPage(storage, { slug: "people/alice", type: "person", title: "Alice" });
    await putPage(storage, {
      slug: "meetings/2026-05-18-standup",
      type: "meeting",
      title: "Standup",
      compiled_truth: { date: "2026-05-18", attendees: ["Alice"] },
    });
    await extractMeetingTimelinePhase(storage);
    await extractMeetingTimelinePhase(storage); // second run
    // alice has exactly ONE attended row, not two (no append-dup)
    expect(await timelineFor("people/alice")).toHaveLength(1);
  });

  it("reflects a corrected date (old event does not linger)", async () => {
    await putPage(storage, { slug: "people/alice", type: "person", title: "Alice" });
    await putPage(storage, {
      slug: "meetings/standup",
      type: "meeting",
      title: "Standup",
      compiled_truth: { date: "2026-05-18", attendees: ["Alice"] },
    });
    await extractMeetingTimelinePhase(storage);
    // correct the date
    await putPage(storage, {
      slug: "meetings/standup",
      type: "meeting",
      title: "Standup",
      compiled_truth: { date: "2026-06-01", attendees: ["Alice"] },
    });
    await extractMeetingTimelinePhase(storage);
    const alice = await timelineFor("people/alice");
    expect(alice).toHaveLength(1); // exactly one, at the corrected date
    expect(alice[0]!.occurred_at).toBe("2026-06-01");
  });
});
