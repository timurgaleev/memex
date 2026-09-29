/**
 * On-demand fact extraction preview (backing the extract_facts MCP tool):
 * returns facts WITHOUT persisting, default-OFF, budget-guarded. Stubbed model,
 * no Bedrock.
 */
import { describe, expect, it } from "bun:test";
import { extractFactsOnDemand } from "../src/core/facts-extract.ts";
import type { SonnetFn } from "../src/core/llm/sonnet.ts";

const stub: SonnetFn = async (input) => {
  const m = input.user.match(/<turn>\s*([^:]+):/);
  const speaker = (m?.[1] ?? "someone").trim();
  return {
    text: JSON.stringify({
      facts: [
        { fact: `${speaker} likes tea`, kind: "preference", entity: speaker, confidence: 0.9, notability: "medium" },
      ],
    }),
    modelId: "eu.anthropic.claude-sonnet-4-6-v1:0",
    usage: { inputTokens: 100, outputTokens: 50 },
  };
};

describe("extractFactsOnDemand", () => {
  it("extracts facts from text via an injected model and reports spend", async () => {
    const r = await extractFactsOnDemand("Alice: I really enjoy a cup of tea", {
      sonnetFn: stub,
      maxBudgetUsd: 1.0,
    });
    expect(r.enabled).toBe(true);
    expect(r.facts.length).toBe(1);
    expect(r.facts[0]?.fact).toBe("Alice likes tea");
    expect(r.spentUsd).toBeGreaterThan(0);
    expect(r.skipped).toBeUndefined();
  });

  it("is default-OFF without the env gate and no injected model", async () => {
    const r = await extractFactsOnDemand("Alice: I like tea");
    expect(r.enabled).toBe(false);
    expect(r.facts).toEqual([]);
    expect(r.skipped).toBe("extraction_disabled");
  });

  it("returns empty (not error) for blank text", async () => {
    const r = await extractFactsOnDemand("   ", { sonnetFn: stub });
    expect(r.enabled).toBe(true);
    expect(r.facts).toEqual([]);
    expect(r.skipped).toBe("empty_text");
  });

  it("stops before spending when the budget is too small", async () => {
    const r = await extractFactsOnDemand("Alice: I like tea", {
      sonnetFn: stub,
      maxBudgetUsd: 0.0005, // below the worst-case per-call ceiling
    });
    expect(r.enabled).toBe(true);
    expect(r.facts).toEqual([]);
    expect(r.spentUsd).toBe(0);
    expect(r.skipped).toBe("budget_exhausted");
  });
});
