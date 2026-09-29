/**
 * Token-budget trimming — pure tests (no DB, no Bedrock).
 */
import { describe, it, expect } from "bun:test";
import { applyTokenBudget, estTokens } from "../src/core/search/token-budget.ts";

// ~4 chars/token, so a 40-char string ≈ 10 tokens.
const hit = (id: string, chars: number) => ({
  id,
  content: "x".repeat(chars),
});

/** What the returned set actually costs the caller's context window. */
const totalCost = (hits: readonly { content: string; title?: string | null }[]): number =>
  hits.reduce((sum, h) => sum + estTokens(h.content) + estTokens(h.title ?? ""), 0);

describe("applyTokenBudget", () => {
  it("returns all hits unchanged when budget is non-positive / infinite", () => {
    const hits = [hit("a", 40), hit("b", 40)];
    expect(applyTokenBudget(hits, 0)).toEqual(hits);
    expect(applyTokenBudget(hits, -5)).toEqual(hits);
    expect(applyTokenBudget(hits, Number.POSITIVE_INFINITY)).toEqual(hits);
  });

  it("keeps whole hits while they fit", () => {
    // 3 hits × 10 tokens each; budget 20 → first two whole, third dropped.
    const hits = [hit("a", 40), hit("b", 40), hit("c", 40)];
    const out = applyTokenBudget(hits, 20);
    expect(out.map((h) => h.id)).toEqual(["a", "b"]);
    expect(out[0]!.content.length).toBe(40); // untouched
  });

  // Was: "truncates the overflowing tail hit to the remaining budget". The old
  // assertion was wrong — a truncated hit still shipped its whole title, so the
  // cap could be overshot by the very hit that was cut to honour it. Whole
  // items only now: the overflowing hit is dropped, and the caller reads the
  // difference as its drop count (hybrid.ts → recordSearchTelemetry).
  it("drops the overflowing tail hit instead of truncating it", () => {
    // a=10 tokens, budget 15 → a whole, b (100 tokens) does not fit → dropped.
    const hits = [hit("a", 40), hit("b", 400)];
    const out = applyTokenBudget(hits, 15);
    expect(out.map((h) => h.id)).toEqual(["a"]);
    expect(out[0]!.content.length).toBe(40); // returned intact, never cut
    expect(hits.length - out.length).toBe(1); // counted as a drop
  });

  // Was: "always returns at least the top hit, truncated if it alone
  // overflows". That floor is what made the cap a suggestion — the caller asked
  // for a ceiling, so an unaffordable top hit yields nothing.
  it("returns nothing when the first hit alone exceeds the budget", () => {
    const hits = [hit("a", 4000), hit("b", 40)];
    expect(applyTokenBudget(hits, 5)).toEqual([]);
  });

  it("stops at the first hit that does not fit, keeping the set a prefix", () => {
    // c would fit in what b left behind, but admitting it would return a set
    // that is no longer the top of the ranking.
    const hits = [hit("a", 40), hit("b", 400), hit("c", 20)];
    expect(applyTokenBudget(hits, 20).map((h) => h.id)).toEqual(["a"]);
  });

  it("never returns more tokens than the budget", () => {
    // The regression that motivated whole-items-only: a 400-char title under a
    // 50-token budget used to come back as 102 tokens.
    const oversizedTitle = [{ content: "x".repeat(2000), title: "t".repeat(400) }];
    expect(totalCost(applyTokenBudget(oversizedTitle, 50))).toBeLessThanOrEqual(50);

    // Sweep a spread of budgets over a mixed set — the cap holds for every one.
    const mixed = [
      { content: "x".repeat(120), title: "a title" },
      { content: "y".repeat(600), title: null },
      { content: "z".repeat(40), title: "t".repeat(300) },
      { content: "w".repeat(4000), title: "another title" },
    ];
    for (const budget of [1, 5, 17, 50, 120, 400, 1200]) {
      expect(totalCost(applyTokenBudget(mixed, budget))).toBeLessThanOrEqual(budget);
    }
  });

  it("does not mutate the input hits", () => {
    const hits = [hit("a", 40), hit("b", 400)];
    const snapshot = hits.map((h) => h.content);
    applyTokenBudget(hits, 12);
    expect(hits.map((h) => h.content)).toEqual(snapshot);
  });
});

describe("title is charged against the budget", () => {
  it("counts the title, so the cap is not overshot by it", () => {
    const long = "x".repeat(400); // ~100 tokens of body
    // Body alone fits in 150; body + title (100 more) does not, so the hit goes.
    expect(applyTokenBudget([{ content: long, title: "y".repeat(400) }], 150)).toEqual([]);

    const noTitle = applyTokenBudget([{ content: long, title: null }], 150);
    expect(noTitle[0]!.content).toBe(long);
  });

  it("keeps a titled hit out when only its body would have fit", () => {
    const body = "x".repeat(200); // ~50 tokens
    const two = applyTokenBudget(
      [
        { content: body, title: null },
        { content: body, title: "t".repeat(200) },
      ],
      110,
    );
    // 50 + (50 + 50) > 110 — the second hit is dropped, not admitted whole.
    expect(two.length).toBe(1);
    expect(two[0]!.title).toBeNull();
  });
});
