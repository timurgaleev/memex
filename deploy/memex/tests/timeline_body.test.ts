/**
 * Body timeline parsing on write: `## Timeline` bullets, `### date` headers and
 * `[Source: X, date]` citations become the page's own timeline rows, reconciled
 * by a keyed diff that never touches manual or meeting-derived rows.
 */
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { putPage } from "../src/core/pages.ts";
import { registerSource } from "../src/core/sources.ts";
import { addTimelineEvent, getEntityTimeline } from "../src/core/timeline.ts";
import {
  bodyTimelineEnabled,
  parseBodyTimeline,
  syncBodyTimelineForPage,
} from "../src/core/timeline-body.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";
import { mergePage } from "../src/core/entity-merge.ts";

setDefaultTimeout(30000);

const SLUG = "projects/apollo";

const BODY = [
  "# Apollo",
  "",
  "Intro prose. [Source: Board memo, 2026-01-15]",
  "",
  "## Timeline",
  "- 2026-02-01 — Contract drafted",
  "- **2026-02-10** Contract signed",
  "",
  "### 2026-03-02 — Kickoff",
  "Team met. [Source: Ops log, 2026-03-02]",
  "",
].join("\n");

let tmp: string;
let storage: Storage;
let prevToggle: string | undefined;
let prevSync: string | undefined;

beforeEach(async () => {
  prevToggle = process.env.MEMEX_BODY_TIMELINE;
  prevSync = process.env.MEMEX_PAGE_MIRROR_SYNC;
  delete process.env.MEMEX_BODY_TIMELINE;
  // Queue the search mirror instead of embedding inline: these tests never
  // look at search, and it keeps page_put hermetic.
  process.env.MEMEX_PAGE_MIRROR_SYNC = "0";
  tmp = mkdtempSync(join(tmpdir(), "memex-bodytl-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});
afterEach(async () => {
  if (prevToggle === undefined) delete process.env.MEMEX_BODY_TIMELINE;
  else process.env.MEMEX_BODY_TIMELINE = prevToggle;
  if (prevSync === undefined) delete process.env.MEMEX_PAGE_MIRROR_SYNC;
  else process.env.MEMEX_PAGE_MIRROR_SYNC = prevSync;
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

interface Row {
  id: number;
  day: string;
  event: string;
  detail: string;
  source_chunk_id: string | null;
  source_id: string;
}

async function rows(slug = SLUG): Promise<Row[]> {
  const r = await storage.engine().query<Row>(
    `SELECT id, occurred_at::date::text AS day, event, detail, source_chunk_id, source_id
       FROM timeline_events WHERE slug = $1 ORDER BY id`,
    [slug],
  );
  return r.rows;
}

async function callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = await dispatchTool(storage, { name, arguments: args });
  expect(r.isError ?? false).toBe(false);
  return JSON.parse((r.content[0] as { text: string }).text) as Record<string, unknown>;
}

describe("parseBodyTimeline", () => {
  it("extracts bullets, a ### header and citations", () => {
    const evs = parseBodyTimeline(BODY);
    expect(evs.map((e) => [e.kind, e.date, e.event])).toEqual([
      ["bullet", "2026-02-01", "Contract drafted"],
      ["bullet", "2026-02-10", "Contract signed"],
      ["header", "2026-03-02", "Kickoff"],
      ["citation", "2026-01-15", "Intro prose."],
      ["citation", "2026-03-02", "Team met."],
    ]);
    expect(evs[3]!.detail).toBe("Source: Board memo");
  });

  it("keeps Timeline bullets and headers when citations above them exceed the cap", () => {
    const cited = Array.from(
      { length: 250 },
      (_, i) => `Claim ${i}. [Source: Memo ${i}, 2025-01-${String((i % 28) + 1).padStart(2, "0")}]`,
    );
    const body = [
      "# Page",
      ...cited,
      "### 2026-04-01 — Review",
      "## Timeline",
      "- 2026-05-01 — First",
      "- 2026-05-02 — Second",
    ].join("\n");
    const evs = parseBodyTimeline(body);
    expect(evs).toHaveLength(200);
    expect(evs.slice(0, 3).map((e) => [e.kind, e.event])).toEqual([
      ["header", "Review"],
      ["bullet", "First"],
      ["bullet", "Second"],
    ]);
    expect(evs.filter((e) => e.kind === "citation")).toHaveLength(197);
  });

  it("accepts the colon bullet form", () => {
    const evs = parseBodyTimeline("## Timeline\n- 2026-04-01: Launched\n");
    expect(evs).toEqual([{ kind: "bullet", date: "2026-04-01", event: "Launched", detail: "" }]);
  });

  it("ignores bullets outside the Timeline section and dates inside code", () => {
    const body = [
      "## Notes",
      "- 2026-01-01 — not a timeline bullet",
      "## Timeline",
      "- 2026-01-02 — kept",
      "```",
      "- 2026-01-03 — in a fence",
      "### 2026-01-04 — fenced header",
      "```",
      "`[Source: Inline, 2026-01-05]` sample",
      "## After",
      "- 2026-01-06 — section closed",
    ].join("\n");
    expect(parseBodyTimeline(body).map((e) => e.event)).toEqual(["kept"]);
  });

  it("skips invalid calendar dates", () => {
    const body = "## Timeline\n- 2026-13-01 — bad month\n- 2026-02-30 — bad day\n- 1899-12-31 — too early\n- 2024-02-29 — leap ok\n";
    expect(parseBodyTimeline(body).map((e) => e.date)).toEqual(["2024-02-29"]);
  });

  it("dedups (date, event) and caps a page at 200 events", () => {
    const dup = "## Timeline\n- 2026-01-01 — same\n- 2026-01-01 — same\n";
    expect(parseBodyTimeline(dup)).toHaveLength(1);
    const lines = ["## Timeline"];
    for (let i = 0; i < 300; i++) lines.push(`- 2026-01-01 — event ${i}`);
    expect(parseBodyTimeline(lines.join("\n"))).toHaveLength(200);
  });

  it("stays linear on adversarial input", () => {
    const time = (input: string): number => {
      const samples: number[] = [];
      for (let k = 0; k < 5; k++) {
        const t0 = performance.now();
        parseBodyTimeline(input);
        samples.push(performance.now() - t0);
      }
      samples.sort((a, b) => a - b);
      return Math.max(samples[2]!, 0.05);
    };
    const shapes: Array<(n: number) => string> = [
      (n) => `## Timeline\n- 2026-01-01 ${"a".repeat(n)}`,
      (n) => `## Timeline\n${`- 2026-01-01 ${"a".repeat(2100)}\n`.repeat(Math.ceil(n / 2100))}`,
      (n) => "[Source:".repeat(Math.ceil(n / 8)),
      (n) => `x ${"[Source: a, 2026-01-0".repeat(Math.ceil(n / 21))}`,
      (n) => "#".repeat(n),
    ];
    for (const shape of shapes) {
      const n = 200_000;
      time(shape(n)); // warm-up
      const ratio = time(shape(2 * n)) / time(shape(n));
      expect(ratio).toBeLessThan(3);
    }
  });
});

describe("syncBodyTimelineForPage", () => {
  it("is on by default and off only for 0", () => {
    expect(bodyTimelineEnabled(undefined)).toBe(true);
    expect(bodyTimelineEnabled("1")).toBe(true);
    expect(bodyTimelineEnabled("0")).toBe(false);
  });

  it("keeps row ids across an unchanged re-sync", async () => {
    await putPage(storage, { slug: SLUG, type: "note", markdown_body: BODY });
    const first = await syncBodyTimelineForPage(storage, SLUG, "note", BODY);
    expect(first).toEqual({ derived: 5, added: 5, removed: 0 });
    const before = await rows();
    const second = await syncBodyTimelineForPage(storage, SLUG, "note", BODY);
    expect(second).toEqual({ derived: 5, added: 0, removed: 0 });
    expect(await rows()).toEqual(before);
    for (const r of before) expect(r.source_chunk_id).toMatch(/^body-timeline:projects\/apollo:[0-9a-f]{16}$/);
  });

  it("replaces only an edited bullet and leaves foreign rows alone", async () => {
    await putPage(storage, { slug: SLUG, type: "note", markdown_body: BODY });
    await syncBodyTimelineForPage(storage, SLUG, "note", BODY);
    await addTimelineEvent(storage, { slug: SLUG, occurred_at: "2026-05-01", event: "manual entry" });
    await addTimelineEvent(storage, {
      slug: SLUG,
      occurred_at: "2026-05-02",
      event: "Meeting: sync",
      source_chunk_id: `meeting-timeline:${SLUG}`,
    });
    const before = await rows();

    const edited = BODY.replace("Contract signed", "Contract countersigned");
    expect(await syncBodyTimelineForPage(storage, SLUG, "note", edited)).toEqual({
      derived: 5,
      added: 1,
      removed: 1,
    });
    const after = await rows();
    const gone = before.filter((b) => !after.some((a) => a.id === b.id));
    const fresh = after.filter((a) => !before.some((b) => b.id === a.id));
    expect(gone.map((r) => r.event)).toEqual(["Contract signed"]);
    expect(fresh.map((r) => r.event)).toEqual(["Contract countersigned"]);

    // Emptying the body removes every derived row and nothing else.
    expect(await syncBodyTimelineForPage(storage, SLUG, "note", "# Apollo\n")).toEqual({
      derived: 0,
      added: 0,
      removed: 5,
    });
    expect((await rows()).map((r) => r.event).sort()).toEqual(["Meeting: sync", "manual entry"]);
  });

  it("derives nothing for a diary page", async () => {
    await putPage(storage, { slug: "life/diary/2026-03-02", type: "note", markdown_body: BODY });
    await putPage(storage, { slug: "notes/journal-day", type: "journal", markdown_body: BODY });
    expect((await syncBodyTimelineForPage(storage, "life/diary/2026-03-02", "note", BODY)).derived).toBe(0);
    expect((await syncBodyTimelineForPage(storage, "notes/journal-day", "journal", BODY)).derived).toBe(0);
    expect(await rows("life/diary/2026-03-02")).toEqual([]);
    expect(await rows("notes/journal-day")).toEqual([]);
  });

  it("MEMEX_BODY_TIMELINE=0 derives nothing and removes nothing", async () => {
    await putPage(storage, { slug: SLUG, type: "note", markdown_body: BODY });
    await syncBodyTimelineForPage(storage, SLUG, "note", BODY);
    process.env.MEMEX_BODY_TIMELINE = "0";
    expect(await syncBodyTimelineForPage(storage, SLUG, "note", "# empty\n")).toEqual({
      derived: 0,
      added: 0,
      removed: 0,
    });
    expect(await rows()).toHaveLength(5);
  });
});

describe("write paths", () => {
  it("page_put reports counts, is a no-op on an identical re-put and diffs an edit", async () => {
    const first = await callTool("page_put", { slug: SLUG, type: "note", markdown_body: BODY });
    expect(first["body_timeline"]).toEqual({ derived: 5, added: 5, removed: 0 });
    const ids = (await rows()).map((r) => r.id);

    const again = await callTool("page_put", { slug: SLUG, type: "note", markdown_body: BODY });
    expect(again["changed"]).toBe(false);
    expect(again["body_timeline"]).toBeUndefined();
    expect((await rows()).map((r) => r.id)).toEqual(ids);

    const edited = await callTool("page_put", {
      slug: SLUG,
      type: "note",
      markdown_body: BODY.replace("- 2026-02-01 — Contract drafted\n", ""),
    });
    expect(edited["body_timeline"]).toEqual({ derived: 4, added: 0, removed: 1 });
  });

  it("an append that adds one bullet performs exactly one insert", async () => {
    const log = ["# Log", "", "## Timeline", ...Array.from(
      { length: 50 },
      (_, i) => `- 2026-01-${String((i % 28) + 1).padStart(2, "0")} — Entry ${i}`,
    )].join("\n");
    await callTool("page_put", { slug: SLUG, type: "note", markdown_body: log });
    expect(await rows()).toHaveLength(50);

    const engine = storage.engine();
    const original = engine.query.bind(engine);
    let inserts = 0;
    engine.query = (async (sql: string, params?: unknown[]) => {
      if (/INSERT INTO timeline_events/.test(sql)) inserts += 1;
      return original(sql, params);
    }) as typeof engine.query;
    try {
      await callTool("page_append", { slug: SLUG, content: "- 2026-02-01 — Entry new" });
    } finally {
      engine.query = original;
    }
    expect(inserts).toBe(1);
    expect(await rows()).toHaveLength(51);
  });

  it("a merge drops the stub's body rows so the canonical shows a shared bullet once", async () => {
    const bullet = "## Timeline\n- 2026-02-01 — Contract drafted\n";
    await callTool("page_put", { slug: SLUG, type: "note", markdown_body: `# Apollo\n\n${bullet}` });
    await callTool("page_put", { slug: "apollo", type: "note", markdown_body: `# Stub\n\n${bullet}` });
    await addTimelineEvent(storage, { slug: "apollo", occurred_at: "2026-02-03", event: "Manual note" });

    const merged = await mergePage(storage, "apollo", SLUG);
    expect(merged.merged).toBe(true);
    const afterMerge = await rows();
    expect(afterMerge.map((r) => r.event).sort()).toEqual(["Contract drafted", "Manual note"]);

    await callTool("page_put", {
      slug: SLUG,
      type: "note",
      markdown_body: `# Apollo\n\nEdited intro.\n\n${bullet}`,
    });
    const drafted = (await rows()).filter((r) => r.event === "Contract drafted");
    expect(drafted).toHaveLength(1);
    expect(drafted[0]!.source_chunk_id!.startsWith(`body-timeline:${SLUG}:`)).toBe(true);
  });

  it("a page without dated lines keeps its page_put result unchanged", async () => {
    const r = await callTool("page_put", { slug: "notes/plain", type: "note", markdown_body: "Just prose." });
    expect("body_timeline" in r).toBe(false);
  });

  it("page_append and page_revert re-derive from the stored body", async () => {
    await callTool("page_put", { slug: SLUG, type: "note", markdown_body: "# Apollo\n\n## Timeline\n" });
    expect(await rows()).toHaveLength(0);
    await callTool("page_append", { slug: SLUG, content: "- 2026-06-01 — Appended milestone" });
    expect((await rows()).map((r) => r.event)).toEqual(["Appended milestone"]);
    await callTool("page_revert", { slug: SLUG, version: 1 });
    expect(await rows()).toHaveLength(0);
  });

  it("stamps the page owner's source on an operator write, and an empty grant reads nothing", async () => {
    await registerSource(storage.engine(), { id: "acme", kind: "vault", pathPrefix: "/acme" });
    await putPage(storage, { slug: "acme/deal", type: "note", markdown_body: "# Deal\n", source_id: "acme" });
    await callTool("page_put", { slug: "acme/deal", type: "note", markdown_body: BODY });
    const got = await rows("acme/deal");
    expect(got).toHaveLength(5);
    for (const r of got) expect(r.source_id).toBe("acme");
    expect(await getEntityTimeline(storage, "acme/deal", { sourceIds: ["acme"] })).toHaveLength(5);
    expect(await getEntityTimeline(storage, "acme/deal", { sourceIds: [] })).toEqual([]);
  });
});
