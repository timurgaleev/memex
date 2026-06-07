/**
 * Token-budget trimming — pure tests (no DB, no Bedrock).
 */
import { describe, it, expect } from "bun:test";
import { applyTokenBudget } from "../src/core/search/token-budget.ts";

// ~4 chars/token, so a 40-char string ≈ 10 tokens.
const hit = (id: string, chars: number) => ({
  id,
  content: "x".repeat(chars),
});

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

  it("truncates the overflowing tail hit to the remaining budget", () => {
    // a=10 tokens, budget 15 → a whole, b truncated to ~5 tokens (~20 chars).
    const hits = [hit("a", 40), hit("b", 400)];
    const out = applyTokenBudget(hits, 15) as Array<{
      id: string;
      content: string;
      truncated?: boolean;
    }>;
    expect(out.map((h) => h.id)).toEqual(["a", "b"]);
    expect(out[1]!.content.length).toBeLessThan(400);
    expect(out[1]!.content.endsWith("…")).toBe(true);
    expect(out[1]!.truncated).toBe(true); // tail hit flagged
    expect((out[0] as { truncated?: boolean }).truncated).toBeUndefined(); // whole hit not flagged
  });

  it("always returns at least the top hit, truncated if it alone overflows", () => {
    const hits = [hit("a", 4000), hit("b", 40)];
    const out = applyTokenBudget(hits, 5); // 5 tokens ≈ 20 chars
    expect(out.length).toBe(1);
    expect(out[0]!.id).toBe("a");
    expect(out[0]!.content.length).toBeLessThan(4000);
    expect(out[0]!.content.endsWith("…")).toBe(true);
  });

  it("does not mutate the input hits", () => {
    const hits = [hit("a", 40), hit("b", 400)];
    const snapshot = hits.map((h) => h.content);
    applyTokenBudget(hits, 12);
    expect(hits.map((h) => h.content)).toEqual(snapshot);
  });

  it("cuts on a word boundary so no word is split", () => {
    const words = { id: "a", content: "alpha beta gamma delta epsilon zeta" };
    const out = applyTokenBudget([words], 4); // ~16 chars → boundary at "alpha beta"
    const body = out[0]!.content.replace(/…$/, "");
    // Every word in the truncated body is a whole word from the original.
    expect(out[0]!.content.endsWith("…")).toBe(true);
    expect(words.content.startsWith(body)).toBe(true);
    const nextChar = words.content[body.length];
    expect(nextChar === undefined || nextChar === " ").toBe(true);
  });
});
