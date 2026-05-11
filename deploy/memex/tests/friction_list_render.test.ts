/**
 * Tests for `listFrictionEvents` + `renderFrictionMarkdown`.
 *
 * Coverage:
 *   - filters by kind, skill, since-hours, limit
 *   - list returns JSON-shaped events with extra parsed
 *   - render: redacts query/reason by default, opt-out via redact=false
 *   - render handles empty inputs gracefully
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import {
  listFrictionEvents,
  logFriction,
  renderFrictionMarkdown,
} from "../src/core/friction.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-fric-list-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("listFrictionEvents", () => {
  it("returns recent events newest-first", async () => {
    const e = storage.engine();
    await logFriction(e, { kind: "search-miss", query: "first" });
    await logFriction(e, { kind: "wrong-answer", query: "second" });
    const events = await listFrictionEvents(e);
    expect(events.length).toBe(2);
    expect(events[0]?.query).toBe("second");
    expect(events[1]?.query).toBe("first");
  });

  it("filters by kind", async () => {
    const e = storage.engine();
    await logFriction(e, { kind: "search-miss", query: "miss" });
    await logFriction(e, { kind: "tool-error", query: "boom" });
    const events = await listFrictionEvents(e, { kind: "tool-error" });
    expect(events.length).toBe(1);
    expect(events[0]?.kind).toBe("tool-error");
  });

  it("filters by skill via extra->>'skill'", async () => {
    const e = storage.engine();
    await logFriction(e, {
      kind: "search-miss",
      query: "a",
      extra: { skill: "brain-recall" },
    });
    await logFriction(e, {
      kind: "search-miss",
      query: "b",
      extra: { skill: "telegram-history" },
    });
    await logFriction(e, { kind: "search-miss", query: "c" });
    const events = await listFrictionEvents(e, { skill: "brain-recall" });
    expect(events.length).toBe(1);
    expect(events[0]?.query).toBe("a");
  });

  it("respects --limit", async () => {
    const e = storage.engine();
    for (let i = 0; i < 5; i++) {
      await logFriction(e, { kind: "search-miss", query: `q${i}` });
    }
    const events = await listFrictionEvents(e, { limit: 2 });
    expect(events.length).toBe(2);
  });

  it("parses extra into an object even when stored as JSONB string", async () => {
    const e = storage.engine();
    await logFriction(e, {
      kind: "wrong-answer",
      query: "x",
      extra: { skill: "s", retries: 3 },
    });
    const events = await listFrictionEvents(e);
    expect(events[0]?.extra).toEqual({ skill: "s", retries: 3 });
  });

  it("persists severity and surfaces it on read", async () => {
    const e = storage.engine();
    await logFriction(e, {
      kind: "wrong-answer",
      query: "x",
      severity: "blocker",
    });
    const [event] = await listFrictionEvents(e);
    expect(event?.severity).toBe("blocker");
  });

  it("accepts the new kinds: delight, phase-marker, interrupted", async () => {
    const e = storage.engine();
    await logFriction(e, { kind: "delight", query: "great hit" });
    await logFriction(e, {
      kind: "phase-marker",
      extra: { run_id: "r1", marker: "start" },
    });
    await logFriction(e, { kind: "interrupted", reason: "timeout" });
    const events = await listFrictionEvents(e);
    expect(events.map((x) => x.kind).sort()).toEqual(
      ["delight", "interrupted", "phase-marker"],
    );
  });

  it("rejects an invalid severity value", async () => {
    await expect(
      logFriction(storage.engine(), {
        kind: "wrong-answer",
        query: "x",
        severity: "fatal" as never,
      }),
    ).rejects.toThrow();
  });
});

describe("renderFrictionMarkdown", () => {
  const event = {
    id: 1,
    capturedAt: "2026-05-08T12:00:00Z",
    kind: "search-miss" as const,
    query: "secret query body",
    reason: "missed the topic",
    sourcePath: "/vault/notes/foo.md",
    extra: { skill: "brain-recall" },
  };

  it("redacts query + reason by default", () => {
    const md = renderFrictionMarkdown([event]);
    expect(md).toContain("[redacted]");
    expect(md).not.toContain("secret query body");
    expect(md).not.toContain("missed the topic");
    expect(md).toContain("brain-recall");
    expect(md).toContain("/vault/notes/foo.md");
  });

  it("includes free-text fields when redact=false", () => {
    const md = renderFrictionMarkdown([event], { redact: false });
    expect(md).toContain("secret query body");
    expect(md).toContain("missed the topic");
    expect(md).not.toContain("[redacted]");
  });

  it("emits a placeholder for empty inputs", () => {
    const md = renderFrictionMarkdown([]);
    expect(md).toContain("no friction events");
  });

  it("escapes pipe characters so the markdown table stays well-formed", () => {
    const md = renderFrictionMarkdown(
      [
        {
          ...event,
          query: "weird | query",
          reason: null,
        },
      ],
      { redact: false },
    );
    expect(md).toContain("weird \\| query");
  });
});
