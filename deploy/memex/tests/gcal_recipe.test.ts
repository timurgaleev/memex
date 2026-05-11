/**
 * Tests for the GCal recipe. Stubs `fetch` and the Bedrock client so
 * the suite runs offline and is deterministic. Mirrors
 * `tests/gmail_recipe.test.ts` shape.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  refreshGcalAccessToken,
  _resetGcalTokenCacheForTesting,
  listCalendars,
  listEventsForCalendar,
  extractEventContent,
  classifyEventSignal,
  buildEventMarkdown,
  gcalSourcePath,
  gcalDedupKey,
  pollGcal,
  type GcalEvent,
  type CalendarSummary,
} from "../src/recipes/gcal.ts";
import { Storage } from "../src/core/storage.ts";
import { _resetForTest as _resetThrottle } from "../src/core/throttle.ts";

const SECRET = {
  client_id: "cid",
  client_secret: "csec",
  refresh_token: "rtok",
};

beforeEach(() => _resetGcalTokenCacheForTesting());

describe("refreshGcalAccessToken", () => {
  it("posts form-encoded grant_type=refresh_token", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({ access_token: "atok", expires_in: 3600, token_type: "Bearer" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const r = await refreshGcalAccessToken(SECRET, { fetch: fakeFetch });
    expect(r.accessToken).toBe("atok");
    expect(captured!.url).toBe("https://oauth2.googleapis.com/token");
    expect((captured!.init.body as string)).toContain("grant_type=refresh_token");
    expect((captured!.init.body as string)).toContain("refresh_token=rtok");
  });

  it("caches the access token until ~60s before expiry", async () => {
    let calls = 0;
    const fakeFetch = (async () => {
      calls++;
      return new Response(
        JSON.stringify({ access_token: `atok${calls}`, expires_in: 600, token_type: "Bearer" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const t0 = new Date("2026-05-09T10:00:00Z");
    const r1 = await refreshGcalAccessToken(SECRET, { fetch: fakeFetch, now: t0 });
    const r2 = await refreshGcalAccessToken(SECRET, {
      fetch: fakeFetch,
      now: new Date(t0.getTime() + 60_000),
    });
    expect(r1.accessToken).toBe("atok1");
    expect(r2.accessToken).toBe("atok1");
    expect(calls).toBe(1);

    const r3 = await refreshGcalAccessToken(SECRET, {
      fetch: fakeFetch,
      now: new Date(t0.getTime() + 10 * 60_000),
    });
    expect(r3.accessToken).toBe("atok2");
    expect(calls).toBe(2);
  });

  it("throws when google returns a non-200", async () => {
    const fakeFetch = (async () =>
      new Response("invalid_grant", { status: 400 })) as unknown as typeof fetch;
    await expect(refreshGcalAccessToken(SECRET, { fetch: fakeFetch })).rejects.toThrow(
      /400/,
    );
  });
});

describe("listCalendars", () => {
  it("calls users/me/calendarList and returns id+summary", async () => {
    let urlSeen = "";
    const fakeFetch = (async (url: string) => {
      urlSeen = url;
      return new Response(
        JSON.stringify({
          items: [
            { id: "primary", summary: "Sample" },
            { id: "shared@group.calendar.google.com", summary: "Shared" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const cals = await listCalendars({ accessToken: "atok", fetch: fakeFetch });
    expect(cals.length).toBe(2);
    expect(cals[0]!.id).toBe("primary");
    expect(cals[0]!.summary).toBe("Sample");
    expect(urlSeen).toContain("/users/me/calendarList");
  });

  it("falls back to id when summary is missing", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ items: [{ id: "abc" }] }), {
        status: 200,
      })) as unknown as typeof fetch;
    const cals = await listCalendars({ accessToken: "atok", fetch: fakeFetch });
    expect(cals[0]!.summary).toBe("abc");
  });

  it("throws on non-2xx", async () => {
    const fakeFetch = (async () =>
      new Response("nope", { status: 401 })) as unknown as typeof fetch;
    await expect(
      listCalendars({ accessToken: "atok", fetch: fakeFetch }),
    ).rejects.toThrow(/401/);
  });
});

describe("listEventsForCalendar", () => {
  it("posts timeMin/timeMax/singleEvents/orderBy params and filters cancelled", async () => {
    let urlSeen = "";
    const fakeFetch = (async (url: string) => {
      urlSeen = url;
      return new Response(
        JSON.stringify({
          items: [
            { id: "e1", status: "confirmed", updated: "2026-05-09T10:00:00Z", start: { dateTime: "2026-05-10T09:00:00Z" } },
            { id: "e2", status: "cancelled", updated: "2026-05-09T11:00:00Z", start: { dateTime: "2026-05-10T10:00:00Z" } },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const events = await listEventsForCalendar({
      accessToken: "atok",
      calendarId: "primary",
      timeMin: "2026-05-09T00:00:00Z",
      timeMax: "2026-05-16T00:00:00Z",
      maxResults: 50,
      fetch: fakeFetch,
    });
    expect(events.length).toBe(1);
    expect(events[0]!.id).toBe("e1");
    expect(urlSeen).toContain("/calendars/primary/events");
    expect(urlSeen).toContain("timeMin=2026-05-09T00%3A00%3A00Z");
    expect(urlSeen).toContain("singleEvents=true");
    expect(urlSeen).toContain("orderBy=startTime");
  });

  it("URL-encodes the calendar id", async () => {
    let urlSeen = "";
    const fakeFetch = (async (url: string) => {
      urlSeen = url;
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    await listEventsForCalendar({
      accessToken: "atok",
      calendarId: "shared@group.calendar.google.com",
      timeMin: "2026-05-09T00:00:00Z",
      timeMax: "2026-05-16T00:00:00Z",
      maxResults: 50,
      fetch: fakeFetch,
    });
    expect(urlSeen).toContain("shared%40group.calendar.google.com");
  });

  it("throws on non-2xx", async () => {
    const fakeFetch = (async () =>
      new Response("nope", { status: 401 })) as unknown as typeof fetch;
    await expect(
      listEventsForCalendar({
        accessToken: "atok",
        calendarId: "primary",
        timeMin: "2026-05-09T00:00:00Z",
        timeMax: "2026-05-16T00:00:00Z",
        maxResults: 50,
        fetch: fakeFetch,
      }),
    ).rejects.toThrow(/401/);
  });
});

describe("extractEventContent", () => {
  const cal: CalendarSummary = { id: "primary", summary: "Sample" };

  it("extracts a timed event with attendees and description", () => {
    const e: GcalEvent = {
      id: "e1",
      status: "confirmed",
      summary: "1:1 with Alice",
      description: "Discuss Q2 priorities.",
      location: "Zoom",
      htmlLink: "https://calendar.google.com/abc",
      updated: "2026-05-09T10:00:00Z",
      start: { dateTime: "2026-05-10T09:00:00Z" },
      end: { dateTime: "2026-05-10T10:00:00Z" },
      attendees: [
        { email: "alice@example.com", displayName: "Alice" },
        { email: "alice@example.com" },
      ],
    };
    const x = extractEventContent(e, cal);
    expect(x.title).toBe("1:1 with Alice");
    expect(x.allDay).toBe(false);
    expect(x.start).toBe("2026-05-10T09:00:00Z");
    expect(x.end).toBe("2026-05-10T10:00:00Z");
    expect(x.attendees).toEqual(["Alice <alice@example.com>", "alice@example.com"]);
    expect(x.location).toBe("Zoom");
    expect(x.description).toBe("Discuss Q2 priorities.");
    expect(x.htmlLink).toBe("https://calendar.google.com/abc");
    expect(x.calendarName).toBe("Sample");
  });

  it("extracts an all-day event (start.date only)", () => {
    const e: GcalEvent = {
      id: "all-day-1",
      summary: "Public holiday",
      updated: "2026-05-09T10:00:00Z",
      start: { date: "2026-05-15" },
      end: { date: "2026-05-16" },
    };
    const x = extractEventContent(e, cal);
    expect(x.allDay).toBe(true);
    expect(x.start).toBe("2026-05-15");
    expect(x.end).toBe("2026-05-16");
    expect(x.attendees).toEqual([]);
    expect(x.description).toBe("");
  });

  it("caps attendees at 50 with an overflow marker", () => {
    const attendees = Array.from({ length: 73 }, (_, i) => ({
      email: `user${i}@example.com`,
      displayName: `User ${i}`,
    }));
    const e: GcalEvent = {
      id: "big-invite",
      summary: "Company all-hands",
      updated: "2026-05-09T10:00:00Z",
      start: { dateTime: "2026-05-10T09:00:00Z" },
      end: { dateTime: "2026-05-10T10:00:00Z" },
      attendees,
    };
    const x = extractEventContent(e, cal);
    expect(x.attendees.length).toBe(51); // 50 + overflow marker
    expect(x.attendees[50]).toBe("+23 more");
  });

  it("caps description at 4 KiB", () => {
    const big = "x".repeat(8000);
    const e: GcalEvent = {
      id: "long",
      summary: "Long event",
      description: big,
      updated: "2026-05-09T10:00:00Z",
      start: { dateTime: "2026-05-10T09:00:00Z" },
      end: { dateTime: "2026-05-10T10:00:00Z" },
    };
    const x = extractEventContent(e, cal);
    expect(x.description.length).toBeLessThanOrEqual(4096);
  });
});

function bedrockStub(text: string) {
  return {
    send: async () => ({ output: { message: { content: [{ text }] } } }),
  } as unknown as import("@aws-sdk/client-bedrock-runtime").BedrockRuntimeClient;
}

describe("classifyEventSignal", () => {
  it("parses a clean JSON object", async () => {
    const r = await classifyEventSignal({
      client: bedrockStub('{"score": 0.92, "reason": "1:1 with manager"}'),
      modelId: "global.amazon.nova-2-lite-v1:0",
      title: "1:1 with Alice",
      start: "2026-05-10T09:00:00Z",
      attendees: ["Alice <alice@example.com>"],
      bodyExcerpt: "Discuss Q2 priorities.",
    });
    expect(r.score).toBeCloseTo(0.92);
    expect(r.reason).toContain("1:1");
  });

  it("tolerates a code-fenced JSON response", async () => {
    const r = await classifyEventSignal({
      client: bedrockStub('```json\n{"score": 0.05, "reason": "auto holiday"}\n```'),
      modelId: "x",
      title: "Public holiday",
      start: "2026-05-15",
      attendees: [],
      bodyExcerpt: "",
    });
    expect(r.score).toBeCloseTo(0.05);
  });

  it("clamps score to [0, 1]", async () => {
    const high = await classifyEventSignal({
      client: bedrockStub('{"score": 1.7, "reason": "x"}'),
      modelId: "x",
      title: "t",
      start: "s",
      attendees: [],
      bodyExcerpt: "b",
    });
    expect(high.score).toBe(1);
    const low = await classifyEventSignal({
      client: bedrockStub('{"score": -0.3, "reason": "x"}'),
      modelId: "x",
      title: "t",
      start: "s",
      attendees: [],
      bodyExcerpt: "b",
    });
    expect(low.score).toBe(0);
  });

  it("throws when the response is not parseable", async () => {
    await expect(
      classifyEventSignal({
        client: bedrockStub("the model went off the rails"),
        modelId: "x",
        title: "t",
        start: "s",
        attendees: [],
        bodyExcerpt: "b",
      }),
    ).rejects.toThrow(/parse/i);
  });
});

describe("buildEventMarkdown", () => {
  it("emits frontmatter + heading + meta + body for a timed event", () => {
    const md = buildEventMarkdown(
      {
        id: "e1",
        calendarId: "primary",
        calendarName: "Sample",
        title: "1:1 with Alice",
        start: "2026-05-10T09:00:00Z",
        end: "2026-05-10T10:00:00Z",
        allDay: false,
        location: "Zoom",
        attendees: ["Alice <alice@example.com>"],
        description: "Discuss Q2 priorities.",
        htmlLink: "https://calendar.google.com/abc",
        updated: "2026-05-09T10:00:00Z",
      },
      { score: 0.92, reason: "1:1 with manager" },
    );
    expect(md.startsWith("---\n")).toBe(true);
    expect(md).toContain("source: gcal");
    expect(md).toContain("calendar_id: 'primary'");
    expect(md).toContain("event_id: 'e1'");
    expect(md).toContain("all_day: false");
    expect(md).toContain("signal_score: 0.92");
    expect(md).toContain("# 1:1 with Alice");
    expect(md).toContain("**Calendar:** Sample");
    expect(md).toContain("**Location:** Zoom");
    expect(md).toContain("**Attendees:** Alice <alice@example.com>");
    expect(md).toContain("Discuss Q2 priorities.");
  });

  it("falls back to '(no title)' when summary is empty", () => {
    const md = buildEventMarkdown(
      {
        id: "e",
        calendarId: "p",
        calendarName: "P",
        title: "",
        start: "2026-05-10T09:00:00Z",
        end: "",
        allDay: false,
        location: "",
        attendees: [],
        description: "",
        htmlLink: "",
        updated: "2026-05-09T10:00:00Z",
      },
      { score: 0.5, reason: "r" },
    );
    expect(md).toContain("title: '(no title)'");
    expect(md).toContain("# (no title)");
  });

  it("escapes single quotes in YAML scalars by doubling", () => {
    const md = buildEventMarkdown(
      {
        id: "e",
        calendarId: "p",
        calendarName: "P",
        title: "It's a 'test'",
        start: "...",
        end: "",
        allDay: false,
        location: "",
        attendees: [],
        description: "",
        htmlLink: "",
        updated: "u",
      },
      { score: 0.5, reason: "edge" },
    );
    expect(md).toContain("title: 'It''s a ''test'''");
  });

  it("omits attendees + location lines when empty", () => {
    const md = buildEventMarkdown(
      {
        id: "e",
        calendarId: "p",
        calendarName: "P",
        title: "Solo block",
        start: "2026-05-10",
        end: "2026-05-11",
        allDay: true,
        location: "",
        attendees: [],
        description: "",
        htmlLink: "",
        updated: "u",
      },
      { score: 0.5, reason: "r" },
    );
    expect(md).not.toContain("attendees:");
    expect(md).not.toContain("location:");
    expect(md).not.toContain("**Location:**");
    expect(md).not.toContain("**Attendees:**");
    expect(md).toContain("all_day: true");
  });
});

describe("gcalSourcePath / gcalDedupKey", () => {
  it("composes a stable source path", () => {
    expect(gcalSourcePath("primary", "abc")).toBe("gcal:primary:abc");
  });
  it("dedup key embeds updated timestamp", () => {
    const k = gcalDedupKey("primary", "abc", "2026-05-09T10:00:00Z");
    expect(k).toBe("primary:abc:2026-05-09T10:00:00Z");
  });
});

interface IndexCall {
  sourcePath: string;
  text: string;
  mtimeMs?: number;
}

function makeIndexStub(): {
  fn: NonNullable<Parameters<typeof pollGcal>[1]>["indexFn"];
  calls: IndexCall[];
} {
  const calls: IndexCall[] = [];
  const fn: NonNullable<Parameters<typeof pollGcal>[1]>["indexFn"] = async (
    _storage,
    input,
  ) => {
    const c: IndexCall = { sourcePath: input.sourcePath, text: input.text };
    if (input.mtimeMs !== undefined) c.mtimeMs = input.mtimeMs;
    calls.push(c);
    return {
      documentId: `doc_${input.sourcePath}`,
      chunks: 1,
      embeddings: 1,
      entities: 0,
    };
  };
  return { fn, calls };
}

interface FakeCal {
  id: string;
  summary: string;
  events: Array<{
    id: string;
    summary: string;
    description?: string;
    updated: string;
    startDateTime?: string;
    startDate?: string;
  }>;
}

function buildFakeFetch(cals: FakeCal[]) {
  return (async (url: string, _init?: RequestInit) => {
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      return new Response(
        JSON.stringify({ access_token: "atok", expires_in: 3600, token_type: "Bearer" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/users/me/calendarList")) {
      return new Response(
        JSON.stringify({ items: cals.map((c) => ({ id: c.id, summary: c.summary })) }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    const eventsMatch = /\/calendars\/([^/]+)\/events\?/.exec(url);
    if (eventsMatch) {
      const calId = decodeURIComponent(eventsMatch[1]!);
      const cal = cals.find((c) => c.id === calId);
      if (!cal) return new Response(JSON.stringify({ items: [] }), { status: 200 });
      return new Response(
        JSON.stringify({
          items: cal.events.map((e) => ({
            id: e.id,
            status: "confirmed",
            summary: e.summary,
            description: e.description ?? "",
            updated: e.updated,
            start: e.startDateTime
              ? { dateTime: e.startDateTime }
              : { date: e.startDate ?? "2026-05-10" },
            end: e.startDateTime
              ? { dateTime: e.startDateTime }
              : { date: e.startDate ?? "2026-05-11" },
          })),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("pollGcal (integration with stubs)", () => {
  let tmp: string;
  let storage: Storage;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "memex-gcal-poll-"));
    storage = new Storage({ dbPath: join(tmp, "db") });
    await storage.init();
    _resetGcalTokenCacheForTesting();
    _resetThrottle();
  });
  afterEach(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("fans out across calendars, ingests high-signal, dedups, persists", async () => {
    const cals: FakeCal[] = [
      {
        id: "primary",
        summary: "Sample",
        events: [
          { id: "high-1", summary: "1:1 Alice", description: "Q2 review.", updated: "u1", startDateTime: "2026-05-10T09:00:00Z" },
        ],
      },
      {
        id: "shared@group.calendar.google.com",
        summary: "Shared",
        events: [
          { id: "low-1", summary: "Holiday", updated: "u2", startDate: "2026-05-15" },
        ],
      },
    ];
    const scoreByTitle: Record<string, number> = { "1:1 Alice": 0.9, Holiday: 0.05 };
    const bedrock = {
      send: async (cmd: { input: { messages: { content: { text: string }[] }[] } }) => {
        const text = cmd.input.messages[0]!.content[0]!.text;
        const m = Object.entries(scoreByTitle).find(([title]) => text.includes(title));
        const score = m ? m[1] : 0;
        return {
          output: { message: { content: [{ text: `{"score": ${score}, "reason": "stub"}` }] } },
        };
      },
    } as unknown as import("@aws-sdk/client-bedrock-runtime").BedrockRuntimeClient;

    const { fn: indexFn, calls } = makeIndexStub();
    const r = await pollGcal(storage, {
      fetch: buildFakeFetch(cals),
      bedrockClient: bedrock,
      secret: { client_id: "x", client_secret: "y", refresh_token: "z" },
      signalThreshold: 0.1,
      now: new Date("2026-05-09T10:00:00Z"),
      systemSensors: { loadAvg1: 0, memoryRssMB: 0 },
      indexFn,
    });
    expect(r.calendarsSeen).toBe(2);
    expect(r.scanned).toBe(2);
    expect(r.processed).toBe(2);
    expect(r.ingested).toBe(1);
    expect(r.skippedLowSignal).toBe(1);
    expect(r.skippedDedup).toBe(0);

    expect(calls.length).toBe(1);
    expect(calls[0]!.sourcePath).toBe("gcal:primary:high-1");
    expect(calls[0]!.text).toContain("# 1:1 Alice");
    expect(calls[0]!.text).toContain("Q2 review.");
    expect(calls[0]!.mtimeMs).toBe(new Date("2026-05-09T10:00:00Z").getTime());
  });

  it("dedups on a second poll when updated timestamp is unchanged", async () => {
    const cals: FakeCal[] = [
      {
        id: "primary",
        summary: "Sample",
        events: [
          { id: "stable", summary: "Standup", updated: "v1", startDateTime: "2026-05-10T09:00:00Z" },
        ],
      },
    ];
    const bedrock = {
      send: async () => ({
        output: { message: { content: [{ text: '{"score": 0.7, "reason": "ok"}' }] } },
      }),
    } as unknown as import("@aws-sdk/client-bedrock-runtime").BedrockRuntimeClient;
    const { fn: indexFn, calls } = makeIndexStub();
    const opts = {
      fetch: buildFakeFetch(cals),
      bedrockClient: bedrock,
      secret: { client_id: "x", client_secret: "y", refresh_token: "z" },
      signalThreshold: 0.1,
      now: new Date("2026-05-09T10:00:00Z"),
      systemSensors: { loadAvg1: 0, memoryRssMB: 0 },
      indexFn,
    };
    const r1 = await pollGcal(storage, opts);
    expect(r1.ingested).toBe(1);
    expect(calls.length).toBe(1);

    const r2 = await pollGcal(storage, opts);
    expect(r2.scanned).toBe(1);
    expect(r2.processed).toBe(0);
    expect(r2.skippedDedup).toBe(1);
    expect(r2.ingested).toBe(0);
    expect(calls.length).toBe(1);
  });

  it("re-ingests a modified event (different `updated`)", async () => {
    const calsV1: FakeCal[] = [
      {
        id: "primary",
        summary: "Sample",
        events: [
          { id: "evt", summary: "Review", updated: "v1", startDateTime: "2026-05-10T09:00:00Z" },
        ],
      },
    ];
    const calsV2: FakeCal[] = [
      {
        id: "primary",
        summary: "Sample",
        events: [
          { id: "evt", summary: "Review", updated: "v2", startDateTime: "2026-05-10T10:00:00Z" },
        ],
      },
    ];
    const bedrock = {
      send: async () => ({
        output: { message: { content: [{ text: '{"score": 0.8, "reason": "ok"}' }] } },
      }),
    } as unknown as import("@aws-sdk/client-bedrock-runtime").BedrockRuntimeClient;
    const { fn: indexFn, calls } = makeIndexStub();
    const baseOpts = {
      bedrockClient: bedrock,
      secret: { client_id: "x", client_secret: "y", refresh_token: "z" },
      signalThreshold: 0.1,
      now: new Date("2026-05-09T10:00:00Z"),
      systemSensors: { loadAvg1: 0, memoryRssMB: 0 },
      indexFn,
    };
    const r1 = await pollGcal(storage, { ...baseOpts, fetch: buildFakeFetch(calsV1) });
    expect(r1.ingested).toBe(1);
    const r2 = await pollGcal(storage, { ...baseOpts, fetch: buildFakeFetch(calsV2) });
    expect(r2.ingested).toBe(1);
    expect(calls.length).toBe(2);
    expect(calls[1]!.sourcePath).toBe("gcal:primary:evt");
  });

  it("retries once on a 401 by refreshing the token", async () => {
    let listCallCount = 0;
    let refreshCount = 0;
    const fakeFetch = (async (url: string) => {
      if (url.startsWith("https://oauth2.googleapis.com/token")) {
        refreshCount++;
        return new Response(
          JSON.stringify({ access_token: `atok-${refreshCount}`, expires_in: 3600 }),
          { status: 200 },
        );
      }
      if (url.includes("/users/me/calendarList")) {
        listCallCount++;
        if (listCallCount === 1) return new Response("expired", { status: 401 });
        return new Response(
          JSON.stringify({ items: [{ id: "primary", summary: "T" }] }),
          { status: 200 },
        );
      }
      if (url.includes("/calendars/primary/events")) {
        return new Response(
          JSON.stringify({
            items: [
              {
                id: "e1",
                status: "confirmed",
                summary: "Recovery test",
                updated: "u1",
                start: { dateTime: "2026-05-10T09:00:00Z" },
                end: { dateTime: "2026-05-10T10:00:00Z" },
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch;

    const bedrock = {
      send: async () => ({
        output: { message: { content: [{ text: '{"score": 0.7, "reason": "ok"}' }] } },
      }),
    } as unknown as import("@aws-sdk/client-bedrock-runtime").BedrockRuntimeClient;

    const { fn: indexFn, calls } = makeIndexStub();
    const r = await pollGcal(storage, {
      fetch: fakeFetch,
      bedrockClient: bedrock,
      secret: { client_id: "x", client_secret: "y", refresh_token: "z" },
      signalThreshold: 0.1,
      now: new Date("2026-05-09T10:00:00Z"),
      systemSensors: { loadAvg1: 0, memoryRssMB: 0 },
      indexFn,
    });
    expect(r.ingested).toBe(1);
    expect(refreshCount).toBeGreaterThanOrEqual(2);
    expect(calls.length).toBe(1);
    expect(calls[0]!.sourcePath).toBe("gcal:primary:e1");
  });

  it("dryRun skips indexFn and dedup persistence", async () => {
    const cals: FakeCal[] = [
      {
        id: "primary",
        summary: "Sample",
        events: [
          { id: "dry-1", summary: "Standup", updated: "v1", startDateTime: "2026-05-10T09:00:00Z" },
        ],
      },
    ];
    const bedrock = {
      send: async () => ({
        output: { message: { content: [{ text: '{"score": 0.9, "reason": "ok"}' }] } },
      }),
    } as unknown as import("@aws-sdk/client-bedrock-runtime").BedrockRuntimeClient;
    const { fn: indexFn, calls } = makeIndexStub();
    const baseOpts = {
      fetch: buildFakeFetch(cals),
      bedrockClient: bedrock,
      secret: { client_id: "x", client_secret: "y", refresh_token: "z" },
      signalThreshold: 0.1,
      now: new Date("2026-05-09T10:00:00Z"),
      systemSensors: { loadAvg1: 0, memoryRssMB: 0 },
      indexFn,
      dryRun: true,
    };
    const r = await pollGcal(storage, baseOpts);
    expect(r.ingested).toBe(1);
    expect(calls.length).toBe(0);
    const r2 = await pollGcal(storage, baseOpts);
    expect(r2.skippedDedup).toBe(0);
  });

  it("one broken calendar does not abort the whole poll", async () => {
    // Two calendars; the second one returns 403 from events.list.
    // Expectation: events from cal A are still ingested, the failure on
    // cal B lands in errors[] with a `calendar:` prefix.
    const fakeFetch = (async (url: string) => {
      if (url.startsWith("https://oauth2.googleapis.com/token")) {
        return new Response(
          JSON.stringify({ access_token: "atok", expires_in: 3600 }),
          { status: 200 },
        );
      }
      if (url.includes("/users/me/calendarList")) {
        return new Response(
          JSON.stringify({
            items: [
              { id: "primary", summary: "Sample" },
              { id: "shared@group.calendar.google.com", summary: "Shared" },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.includes("/calendars/primary/events")) {
        return new Response(
          JSON.stringify({
            items: [
              {
                id: "good-1",
                status: "confirmed",
                summary: "Real meeting",
                updated: "u1",
                start: { dateTime: "2026-05-10T09:00:00Z" },
                end: { dateTime: "2026-05-10T10:00:00Z" },
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.includes("shared")) {
        return new Response("forbidden", { status: 403 });
      }
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch;

    const bedrock = {
      send: async () => ({
        output: { message: { content: [{ text: '{"score": 0.8, "reason": "ok"}' }] } },
      }),
    } as unknown as import("@aws-sdk/client-bedrock-runtime").BedrockRuntimeClient;

    const { fn: indexFn, calls } = makeIndexStub();
    const r = await pollGcal(storage, {
      fetch: fakeFetch,
      bedrockClient: bedrock,
      secret: { client_id: "x", client_secret: "y", refresh_token: "z" },
      signalThreshold: 0.1,
      now: new Date("2026-05-09T10:00:00Z"),
      systemSensors: { loadAvg1: 0, memoryRssMB: 0 },
      indexFn,
    });
    expect(r.ingested).toBe(1);
    expect(calls.length).toBe(1);
    expect(calls[0]!.sourcePath).toBe("gcal:primary:good-1");
    expect(r.errors.length).toBe(1);
    expect(r.errors[0]!.id).toContain("calendar:shared");
    expect(r.errors[0]!.error).toMatch(/403/);
  });

  it("Bedrock classifier failure on one event surfaces in errors[] and persists earlier dedup", async () => {
    const cals: FakeCal[] = [
      {
        id: "primary",
        summary: "Sample",
        events: [
          { id: "first-ok", summary: "Good event", updated: "u1", startDateTime: "2026-05-10T09:00:00Z" },
          { id: "second-boom", summary: "Bad event", updated: "u2", startDateTime: "2026-05-10T10:00:00Z" },
        ],
      },
    ];
    let callIdx = 0;
    const bedrock = {
      send: async () => {
        callIdx++;
        if (callIdx === 2) throw new Error("ThrottlingException: rate exceeded");
        return {
          output: { message: { content: [{ text: '{"score": 0.8, "reason": "ok"}' }] } },
        };
      },
    } as unknown as import("@aws-sdk/client-bedrock-runtime").BedrockRuntimeClient;

    const { fn: indexFn, calls } = makeIndexStub();
    const r = await pollGcal(storage, {
      fetch: buildFakeFetch(cals),
      bedrockClient: bedrock,
      secret: { client_id: "x", client_secret: "y", refresh_token: "z" },
      signalThreshold: 0.1,
      now: new Date("2026-05-09T10:00:00Z"),
      systemSensors: { loadAvg1: 0, memoryRssMB: 0 },
      indexFn,
    });
    expect(r.ingested).toBe(1); // first-ok succeeded
    expect(calls.length).toBe(1);
    expect(r.errors.length).toBe(1);
    expect(r.errors[0]!.id).toContain("primary:second-boom:u2");
    expect(r.errors[0]!.error).toContain("Throttling");

    // Re-poll: first-ok is dedup-persisted (so skipped), second-boom is
    // not (so retried). Bedrock now succeeds for everything.
    const bedrock2 = {
      send: async () => ({
        output: { message: { content: [{ text: '{"score": 0.8, "reason": "ok"}' }] } },
      }),
    } as unknown as import("@aws-sdk/client-bedrock-runtime").BedrockRuntimeClient;
    const { fn: indexFn2, calls: calls2 } = makeIndexStub();
    const r2 = await pollGcal(storage, {
      fetch: buildFakeFetch(cals),
      bedrockClient: bedrock2,
      secret: { client_id: "x", client_secret: "y", refresh_token: "z" },
      signalThreshold: 0.1,
      now: new Date("2026-05-09T10:00:00Z"),
      systemSensors: { loadAvg1: 0, memoryRssMB: 0 },
      indexFn: indexFn2,
    });
    expect(r2.skippedDedup).toBe(1); // first-ok stayed deduped
    expect(r2.ingested).toBe(1); // second-boom retried successfully
    expect(calls2.length).toBe(1);
    expect(calls2[0]!.sourcePath).toBe("gcal:primary:second-boom");
  });

  it("indexFn failure surfaces in errors[] and skips dedup", async () => {
    const cals: FakeCal[] = [
      {
        id: "primary",
        summary: "Sample",
        events: [
          { id: "boom", summary: "Crash test", updated: "v1", startDateTime: "2026-05-10T09:00:00Z" },
        ],
      },
    ];
    const bedrock = {
      send: async () => ({
        output: { message: { content: [{ text: '{"score": 0.9, "reason": "ok"}' }] } },
      }),
    } as unknown as import("@aws-sdk/client-bedrock-runtime").BedrockRuntimeClient;
    const indexFn: NonNullable<Parameters<typeof pollGcal>[1]>["indexFn"] = async () => {
      throw new Error("bedrock embed transient");
    };
    const r = await pollGcal(storage, {
      fetch: buildFakeFetch(cals),
      bedrockClient: bedrock,
      secret: { client_id: "x", client_secret: "y", refresh_token: "z" },
      signalThreshold: 0.1,
      now: new Date("2026-05-09T10:00:00Z"),
      systemSensors: { loadAvg1: 0, memoryRssMB: 0 },
      indexFn,
    });
    expect(r.ingested).toBe(0);
    expect(r.errors.length).toBe(1);
    expect(r.errors[0]!.id).toContain("primary:boom:v1");
    expect(r.errors[0]!.error).toContain("bedrock embed");

    // Not deduped — next poll retries and succeeds
    const { fn: ok } = makeIndexStub();
    const r2 = await pollGcal(storage, {
      fetch: buildFakeFetch(cals),
      bedrockClient: bedrock,
      secret: { client_id: "x", client_secret: "y", refresh_token: "z" },
      signalThreshold: 0.1,
      now: new Date("2026-05-09T10:00:00Z"),
      systemSensors: { loadAvg1: 0, memoryRssMB: 0 },
      indexFn: ok,
    });
    expect(r2.skippedDedup).toBe(0);
    expect(r2.ingested).toBe(1);
  });
});
