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
    });
  });

  it("keeps the whole response near the budget", () => {
    const r = applyRecallBudget(arms(), 200);
    const spent =
      Math.ceil((r.page?.markdown_body ?? "").length / 4) +
      r.facts.reduce((n, f) => n + Math.ceil(String(f.fact).length / 4), 0) +
      r.timeline.reduce((n, e) => n + Math.ceil(String(e.event).length / 4), 0);
    // Allow the one-item overshoot the arms permit, not a multiple.
    expect(spent).toBeLessThanOrEqual(260);
  });

  it("says what it dropped, so a partial view is not read as complete", () => {
    const r = applyRecallBudget(arms(), 100);
    expect(r.report.facts_dropped).toBeGreaterThan(0);
    expect(r.report.page_truncated).toBe(true);
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

  async function recall(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const r = await dispatchTool(storage, {
      name: "entity_recall",
      arguments: { slug: "people/alice", ...args },
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
