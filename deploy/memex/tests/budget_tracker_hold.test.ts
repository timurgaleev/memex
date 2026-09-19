/**
 * A shared BudgetTracker bounds concurrent callers, not only sequential ones.
 *
 * Locks: parallel contextual-LLM calls on one tracker never spend past its cap
 * (each holds its estimate before awaiting the model); a failed call gives its
 * hold back; a hold is settled or released once only.
 */
import { describe, expect, it } from "bun:test";
import { BudgetTracker, costUsd } from "../src/core/budget.ts";
import { generateChunkContext } from "../src/core/search/contextual-llm.ts";

const HAIKU = "eu.anthropic.claude-haiku-4-5-20251001-v1:0";

describe("parallel calls on one tracker", () => {
  it("stay within the cap", async () => {
    const budget = new BudgetTracker(0.002, "test");
    let calls = 0;
    const llmFn = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 5));
      return { text: "situates it", modelId: HAIKU, usage: { inputTokens: 400, outputTokens: 100 } };
    };
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        generateChunkContext("doc ".repeat(200), `chunk ${i}`, { llmFn, budget, modelId: HAIKU }),
      ),
    );
    expect(calls).toBeGreaterThan(0);
    expect(calls).toBeLessThan(20);
    expect(budget.totalSpent()).toBeLessThanOrEqual(0.002);
  });

  it("gives a failed call's hold back", async () => {
    const budget = new BudgetTracker(1, "test");
    const r = await generateChunkContext("doc", "chunk", {
      llmFn: async () => {
        throw new Error("down");
      },
      budget,
      modelId: HAIKU,
    });
    expect(r).toBeNull();
    // Nothing held and nothing spent: the whole cap is still available.
    expect(budget.reserve(HAIKU, { inputTokens: 999_000, outputTokens: 0 })).not.toBeNull();
  });
});

describe("a hold", () => {
  it("is returned once, however often it is released", () => {
    const budget = new BudgetTracker(costUsd(HAIKU, { inputTokens: 1000, outputTokens: 0 }) * 1.5, "t");
    const h = budget.reserve(HAIKU, { inputTokens: 1000, outputTokens: 0 })!;
    budget.release(h);
    budget.release(h);
    // A double release would have freed room for two more calls.
    expect(budget.reserve(HAIKU, { inputTokens: 1000, outputTokens: 0 })).not.toBeNull();
    expect(budget.reserve(HAIKU, { inputTokens: 1000, outputTokens: 0 })).toBeNull();
  });
});
