/**
 * Push-based context — resolver (reflex), confidence gate (volunteer), the
 * fire-and-forget event log, and the `watch` command. DB-backed (PGLite),
 * offline, zero-LLM.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { putPage } from "../src/core/pages.ts";
import { resolveEntitiesToPointers } from "../src/core/context/reflex.ts";
import {
  volunteerContext,
  parseWindow,
  formatVolunteeredPage,
  volunteerUsageStats,
  VOLUNTEER_MAX_PAGES_CAP,
} from "../src/core/context/volunteer.ts";
import {
  volunteerEventRowsFrom,
  insertVolunteerEvents,
  logVolunteerEventsFireAndForget,
  awaitPendingVolunteerEventWrites,
  purgeStaleVolunteerEvents,
  _resetPendingVolunteerEventWritesForTests,
} from "../src/core/context/volunteer-events.ts";
import { isOperationError, type OperationError } from "../src/core/operation-error.ts";
import { runWatch } from "../src/commands/watch.ts";
import type { WindowTurn } from "../src/core/context/entity-salience.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-volunteer-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  _resetPendingVolunteerEventWritesForTests();
  // A person page with a declared alias + a curated summary.
  await putPage(storage, {
    slug: "people/alice",
    type: "person",
    title: "Alice Example",
    compiled_truth: { aliases: ["Ally"], summary: "Founder of Acme, based in NYC." },
    markdown_body: "Alice is a person.\n",
  });
  // A page resolvable by exact title only.
  await putPage(storage, {
    slug: "companies/acme",
    type: "company",
    title: "Acme Inc",
    markdown_body: "Acme builds things.\n",
  });
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function* fromLines(lines: string[]): AsyncIterable<string> {
  for (const l of lines) yield l;
}

const win = (...t: Array<[WindowTurn["role"], string]>): WindowTurn[] =>
  t.map(([role, text]) => ({ role, text }));

describe("parseWindow", () => {
  it("splits role-prefixed lines into turns", () => {
    const out = parseWindow("user: hi\nassistant: hello\nuser: bye");
    expect(out).toEqual([
      { role: "user", text: "hi" },
      { role: "assistant", text: "hello" },
      { role: "user", text: "bye" },
    ]);
  });

  it("treats unprefixed input as one user turn", () => {
    expect(parseWindow("just some text")).toEqual([{ role: "user", text: "just some text" }]);
  });

  it("returns [] for blank input", () => {
    expect(parseWindow("   \n  ")).toEqual([]);
  });
});

describe("resolveEntitiesToPointers", () => {
  it("resolves a declared alias (arm=alias)", async () => {
    const out = await resolveEntitiesToPointers(storage, [{ display: "Ally", query: "Ally" }]);
    const p = out.find((x) => x.slug === "people/alice");
    expect(p?.arm).toBe("alias");
    expect(p?.confidence).toBe(0.9);
  });

  it("resolves an exact title (arm=title)", async () => {
    const out = await resolveEntitiesToPointers(storage, [{ display: "Acme Inc", query: "Acme Inc" }]);
    const p = out.find((x) => x.slug === "companies/acme");
    expect(p?.arm).toBe("title");
    expect(p?.confidence).toBe(0.8);
  });

  it("resolves a slug suffix (arm=slug-suffix)", async () => {
    const out = await resolveEntitiesToPointers(storage, [{ display: "Alice", query: "Alice" }]);
    const p = out.find((x) => x.slug === "people/alice");
    expect(p?.arm).toBe("slug-suffix");
  });

  it("uses the curated summary as the synopsis", async () => {
    const out = await resolveEntitiesToPointers(storage, [{ display: "Ally", query: "Ally" }]);
    expect(out.find((x) => x.slug === "people/alice")?.synopsis).toBe("Founder of Acme, based in NYC.");
  });

  it("returns [] when nothing resolves", async () => {
    expect(await resolveEntitiesToPointers(storage, [{ display: "Nobody Here", query: "Nobody Here" }])).toEqual([]);
  });
});

describe("volunteerContext", () => {
  it("volunteers an alias hit at the default gate with a newest-turn boost", async () => {
    const out = await volunteerContext(storage, { window: win(["user", "tell me about Ally"]) });
    const p = out.find((x) => x.slug === "people/alice");
    expect(p).toBeDefined();
    // alias 0.9 + 0.05 newest-turn boost.
    expect(p?.confidence).toBeCloseTo(0.95, 5);
    expect(p?.rationale).toContain("newest turn");
  });

  it("gates out a slug-suffix hit at the default min_confidence", async () => {
    // "Alice" resolves only via slug-suffix (0.6 + 0.05 = 0.65 < 0.7).
    const out = await volunteerContext(storage, { window: win(["user", "who is Alice"]) });
    expect(out.find((x) => x.slug === "people/alice")).toBeUndefined();
  });

  it("admits a slug-suffix hit at a lowered min_confidence", async () => {
    const out = await volunteerContext(storage, {
      window: win(["user", "who is Alice"]),
      minConfidence: 0.6,
    });
    expect(out.find((x) => x.slug === "people/alice")).toBeDefined();
  });

  it("respects excludeSlugs before the gate and cap", async () => {
    const out = await volunteerContext(storage, {
      window: win(["user", "tell me about Ally"]),
      excludeSlugs: new Set(["people/alice"]),
    });
    expect(out.find((x) => x.slug === "people/alice")).toBeUndefined();
  });

  it("caps the result to maxPages", async () => {
    const out = await volunteerContext(storage, {
      window: win(["user", "Ally and Acme Inc here"]),
      maxPages: 1,
    });
    expect(out.length).toBe(1);
  });

  it("clamps maxPages to the hard cap", async () => {
    const out = await volunteerContext(storage, {
      window: win(["user", "Ally"]),
      maxPages: 999,
    });
    expect(out.length).toBeLessThanOrEqual(VOLUNTEER_MAX_PAGES_CAP);
  });

  it("formats a volunteered page deterministically", async () => {
    const out = await volunteerContext(storage, { window: win(["user", "tell me about Ally"]) });
    const s = formatVolunteeredPage(out[0]!);
    expect(s).toContain("people/alice");
    expect(s).toContain("alias");
  });
});

describe("volunteer-events", () => {
  it("maps pages to rows for a channel", () => {
    const rows = volunteerEventRowsFrom(
      [{ slug: "people/alice", confidence: 0.95, arm: "alias", rationale: "x" }],
      { channel: "op", session_id: "s1", turn: 3 },
    );
    expect(rows[0]).toMatchObject({ slug: "people/alice", channel: "op", session_id: "s1", turn: 3 });
  });

  it("inserts a batch and derives used/volunteered stats", async () => {
    await insertVolunteerEvents(
      storage,
      volunteerEventRowsFrom(
        [{ slug: "people/alice", confidence: 0.95, arm: "alias", rationale: "x" }],
        { channel: "op" },
      ),
    );
    const stats = await volunteerUsageStats(storage, 30);
    expect(stats.total_volunteered).toBe(1);
    expect(stats.approximate).toBe(true);
  });

  it("refuses whole-brain stats for a source-scoped caller", async () => {
    await insertVolunteerEvents(
      storage,
      volunteerEventRowsFrom(
        [{ slug: "people/alice", confidence: 0.95, arm: "alias", rationale: "x" }],
        { channel: "op" },
      ),
    );
    // Operator paths stay unscoped: undefined and [] both see the aggregate.
    expect((await volunteerUsageStats(storage, 30)).total_volunteered).toBe(1);
    expect((await volunteerUsageStats(storage, 30, [])).total_volunteered).toBe(1);

    let caught: unknown;
    try {
      await volunteerUsageStats(storage, 30, ["tenant-a"]);
    } catch (e) {
      caught = e;
    }
    expect(isOperationError(caught)).toBe(true);
    expect((caught as OperationError).code).toBe("permission_denied");
    expect((caught as OperationError).message).toContain("operator-only");
  });

  it("drains fire-and-forget writes", async () => {
    logVolunteerEventsFireAndForget(
      storage,
      volunteerEventRowsFrom([{ slug: "companies/acme", confidence: 0.8, arm: "title", rationale: "y" }], {
        channel: "watch",
      }),
    );
    const { unfinished } = await awaitPendingVolunteerEventWrites();
    expect(unfinished).toBe(0);
    const r = await storage.engine().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM context_volunteer_events`,
    );
    expect(Number(r.rows[0]?.n)).toBe(1);
  });

  it("purges only rows past the TTL", async () => {
    await insertVolunteerEvents(
      storage,
      volunteerEventRowsFrom([{ slug: "people/alice", confidence: 0.9, arm: "alias", rationale: "x" }], {
        channel: "op",
      }),
    );
    // Backdate one row past 90 days.
    await storage.engine().query(
      `UPDATE context_volunteer_events SET volunteered_at = now() - interval '120 days'`,
    );
    const purged = await purgeStaleVolunteerEvents(storage.engine(), 90);
    expect(purged).toBe(1);
    const r = await storage.engine().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM context_volunteer_events`,
    );
    expect(Number(r.rows[0]?.n)).toBe(0);
  });
});

describe("runWatch", () => {
  it("volunteers pages per turn and dedupes a slug across turns (JSONL)", async () => {
    const written: string[] = [];
    await runWatch(
      { json: true },
      {
        storage,
        isTTY: false,
        write: (s) => written.push(s),
        lines: fromLines(["user: tell me about Ally", "user: more on Ally please"]),
      },
    );
    const lines = written.join("").trim().split("\n").filter(Boolean);
    const slugs = lines.map((l) => JSON.parse(l).slug);
    // people/alice volunteered once despite two turns mentioning it.
    expect(slugs.filter((s: string) => s === "people/alice").length).toBe(1);
  });

  it("logs watch-channel events for volunteered pages", async () => {
    await runWatch(
      {},
      { storage, isTTY: false, write: () => {}, lines: fromLines(["user: tell me about Ally"]) },
    );
    const r = await storage.engine().query<{ channel: string }>(
      `SELECT channel FROM context_volunteer_events`,
    );
    expect(r.rows.map((x) => x.channel)).toContain("watch");
  });

  it("emits nothing when no entity clears the gate", async () => {
    const written: string[] = [];
    await runWatch(
      { json: true },
      { storage, isTTY: false, write: (s) => written.push(s), lines: fromLines(["user: hello there friend"]) },
    );
    expect(written.join("")).toBe("");
  });
});
