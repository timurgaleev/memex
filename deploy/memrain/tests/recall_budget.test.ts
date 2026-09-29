/**
 * One token budget across the arms of an entity recall.
 *
 * entity_recall answers "what do I know about X?" with a page, facts and a
 * timeline at once. A caller under a context budget could cap none of them, so
 * it had to guess the split, fetch, measure and call again. The server knows
 * the sizes; guessing is the part worth removing.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { putPage } from "../src/core/pages.ts";
import { addFact } from "../src/core/facts.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";
import { applyRecallBudget } from "../src/core/recall-budget.ts";

/** A page row as the arms see it — the extra fields ride along and are charged. */
const pageRow = (row: Record<string, unknown>) =>
  row as { markdown_body?: string | null };

/** What the budget charges a value: its serialized size, as the arms count it. */
const cost = (v: unknown): number => Math.ceil((JSON.stringify(v) ?? "").length / 4);

/** What the three arms together cost the caller's context window. */
const armsCost = (r: {
  page: unknown;
  facts: readonly unknown[];
  timeline: readonly unknown[];
}): number =>
  (r.page === null ? 0 : cost(r.page)) +
  r.facts.reduce((n: number, f) => n + cost(f), 0) +
  r.timeline.reduce((n: number, e) => n + cost(e), 0);

describe("applyRecallBudget", () => {
  const arms = () => ({
    page: { markdown_body: "p".repeat(4000) }, // ~1000 tokens
    facts: Array.from({ length: 10 }, (_, i) => ({ fact: `f${i}`.repeat(40) })),
    timeline: Array.from({ length: 10 }, (_, i) => ({ event: `e${i}`.repeat(40) })),
  });

  it("returns everything untouched without a budget", () => {
    const r = applyRecallBudget(arms(), 0);
    expect(r.facts).toHaveLength(10);
    expect(r.timeline).toHaveLength(10);
    expect(r.report).toEqual({
      facts_dropped: 0,
      timeline_dropped: 0,
      page_truncated: false,
      page_dropped: false,
    });
  });

  // The old version of this test measured only the headline text of each row
  // and allowed a 30% overshoot. Both were wrong: the tool advertises the
  // budget as a cap on the whole response, so the assertion has to be the cap
  // itself, over the rows as they are actually serialized.
  it("keeps the whole response inside the budget", () => {
    for (const budget of [1, 7, 40, 200, 1000, 100_000]) {
      expect(armsCost(applyRecallBudget(arms(), budget))).toBeLessThanOrEqual(budget);
    }
  });

  it("keeps the page inside the budget when its body serializes larger than it reads", () => {
    // JSON escaping is not 1:1 — a body of quotes and newlines doubles on the
    // wire. Deriving a character count from the token budget under-charges it
    // and breaks the cap on exactly the documents most likely to be pages.
    const r = applyRecallBudget(
      {
        page: pageRow({ markdown_body: '"\n'.repeat(20_000), slug: "notes/quotes" }),
        facts: [],
        timeline: [],
      },
      300,
    );
    expect(cost(r.page)).toBeLessThanOrEqual(300);
    expect(r.report.page_truncated).toBe(true);
  });

  it("says what it dropped, so a partial view is not read as complete", () => {
    const r = applyRecallBudget(arms(), 100);
    expect(r.report.facts_dropped).toBeGreaterThan(0);
    expect(r.report.page_truncated).toBe(true);
  });

  it("leaves out a page it cannot fit even stripped, and says so", () => {
    // A redacted page carries no body to cut, so the only honest moves are
    // "omit it" and "blow the cap". `page: null` alone is indistinguishable
    // from a soft-stub, which is why the report has to carry page_dropped.
    const r = applyRecallBudget(
      {
        page: pageRow({ slug: "people/alice", type: "person", title: "Alice" }),
        facts: [],
        timeline: [],
      },
      3,
    );
    expect(r.page).toBeNull();
    expect(r.report.page_dropped).toBe(true);
    expect(r.report.page_truncated).toBe(false);
  });

  it("keeps a page down to whatever body its own metadata leaves room for", () => {
    const r = applyRecallBudget(
      { page: pageRow({ slug: "x/y", markdown_body: "b".repeat(4000) }), facts: [], timeline: [] },
      10,
    );
    expect(r.page).not.toBeNull();
    expect(r.page?.markdown_body).toMatch(/^b+…$/);
    expect(r.report.page_dropped).toBe(false);
    expect(r.report.page_truncated).toBe(true);
    expect(cost(r.page)).toBeLessThanOrEqual(10);
  });

  it("spends the whole budget on facts when facts are all there is", () => {
    // The common shape: a soft-stub entity with no page and no timeline. Their
    // allocations have nothing to buy, so they belong to the facts arm — a
    // fixed split would answer with half the budget the caller asked for.
    const facts = Array.from({ length: 40 }, (_, i) => ({ fact: `fact ${i} `.repeat(4) }));
    const r = applyRecallBudget({ page: null, facts, timeline: [] }, 400);
    // Well past the 50% share; the shortfall is one whole row's granularity,
    // not a stranded allocation.
    expect(armsCost(r)).toBeGreaterThan(400 * 0.8);
    expect(armsCost(r)).toBeLessThanOrEqual(400);
  });

  it("spends the slack on the timeline when that is the arm with content", () => {
    const timeline = Array.from({ length: 40 }, (_, i) => ({ event: `ev ${i} `.repeat(4) }));
    const r = applyRecallBudget({ page: null, facts: [], timeline }, 400);
    // The timeline's own share is 20% of this.
    expect(armsCost(r)).toBeGreaterThan(400 * 0.8);
    expect(armsCost(r)).toBeLessThanOrEqual(400);
  });

  it("does not let one arm's redistribution starve another's floor", () => {
    // Facts get first claim on the slack, but only on slack: the timeline
    // still gets the share it can actually use.
    const r = applyRecallBudget(
      {
        page: null,
        facts: Array.from({ length: 40 }, (_, i) => ({ fact: `f${i} `.repeat(8) })),
        timeline: [{ event: "shipped" }],
      },
      400,
    );
    expect(r.timeline).toHaveLength(1);
    expect(r.report.timeline_dropped).toBe(0);
    expect(armsCost(r)).toBeLessThanOrEqual(400);
  });

  it("gives the page what the other arms did not use", () => {
    const thin = {
      page: { markdown_body: "p".repeat(4000) },
      facts: [{ fact: "short" }],
      timeline: [],
    };
    const generous = applyRecallBudget(thin, 500);
    const stingy = applyRecallBudget(
      { ...thin, facts: Array.from({ length: 20 }, () => ({ fact: "x".repeat(400) })) },
      500,
    );
    // Same total budget, but the thin-facts case leaves far more for the page.
    expect((generous.page?.markdown_body ?? "").length).toBeGreaterThan(
      (stingy.page?.markdown_body ?? "").length,
    );
  });
});

describe("entity_recall token_budget", () => {
  let tmp: string;
  let storage: Storage;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "memex-recallbudget-"));
    storage = new Storage({ dbPath: join(tmp, "db") });
    await storage.init();
    await putPage(storage, {
      slug: "people/alice",
      type: "person",
      markdown_body: "body ".repeat(400),
    });
    for (let i = 0; i < 12; i++) {
      await addFact(storage, {
        entity_slug: "people/alice",
        fact: `fact number ${i} `.repeat(10),
      });
    }
  });

  afterEach(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  async function recall(
    args: Record<string, unknown>,
    slug = "people/alice",
  ): Promise<Record<string, unknown>> {
    const r = await dispatchTool(storage, {
      name: "entity_recall",
      arguments: { slug, ...args },
    });
    return JSON.parse((r.content[0] as { text: string }).text);
  }

  it("returns the full recall when no budget is asked for", async () => {
    const full = await recall({});
    expect((full.facts as unknown[]).length).toBe(12);
    expect(full.budget).toBeUndefined();
  });

  it("trims to the budget and reports what it cut", async () => {
    const capped = await recall({ token_budget: 120 });
    expect((capped.facts as unknown[]).length).toBeLessThan(12);
    const report = capped.budget as { facts_dropped: number; page_truncated: boolean };
    expect(report.facts_dropped).toBeGreaterThan(0);
    expect(report.page_truncated).toBe(true);
  });

  it("holds the cap over the arms it returns", async () => {
    for (const token_budget of [80, 300, 1200]) {
      const capped = await recall({ token_budget });
      expect(
        armsCost(
          capped as unknown as {
            page: unknown;
            facts: unknown[];
            timeline: unknown[];
          },
        ),
      ).toBeLessThanOrEqual(token_budget);
    }
  });

  it("spends a soft-stub's whole budget on its facts", async () => {
    // people/bob has facts but no page — the shape the fixed split served
    // worst, since the page and timeline allocations had nothing to buy.
    for (let i = 0; i < 20; i++) {
      await addFact(storage, {
        entity_slug: "people/bob",
        fact: `bob fact number ${i} `.repeat(4),
      });
    }
    const capped = await recall({ token_budget: 600 }, "people/bob");
    expect(capped.page).toBeNull();
    const spent = armsCost(
      capped as unknown as { page: unknown; facts: unknown[]; timeline: unknown[] },
    );
    expect(spent).toBeGreaterThan(600 * 0.75);
    expect(spent).toBeLessThanOrEqual(600);
    // A page that never existed is not a budget casualty.
    expect((capped.budget as { page_dropped: boolean }).page_dropped).toBe(false);
  });
});

describe("what the budget actually charges", () => {
  it("charges the whole row, not just its headline text", () => {
    // A fact carries an unbounded `context`; charging only `fact` made the cap
    // a promise the code could not keep — a one-character fact with a 100k
    // context sailed through a 10-token budget.
    const fat = applyRecallBudget(
      {
        page: null,
        facts: [{ fact: "x", context: "c".repeat(100_000) }],
        timeline: [],
      },
      10,
    );
    expect(fat.facts).toHaveLength(0);
    expect(fat.report.facts_dropped).toBe(1);
  });

  it("keeps a page inside the budget including its own metadata", () => {
    const r = applyRecallBudget(
      {
        page: { markdown_body: "b".repeat(40_000), slug: "people/alice" } as Record<
          string,
          unknown
        > as { markdown_body?: string | null },
        facts: [],
        timeline: [],
      },
      50,
    );
    expect(Math.ceil(JSON.stringify(r.page).length / 4)).toBeLessThanOrEqual(50);
    expect(r.report.page_truncated).toBe(true);
  });
});
