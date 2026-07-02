/**
 * Bedrock prompt-caching for the per-chunk contextual-retrieval LLM tier.
 *
 * The document block is the STABLE prefix across every chunk of one document, so
 * it is sent as a `cachePrefix` (a Converse `cachePoint` after the doc block) and
 * reused for the rest of that document's chunks. These tests exercise the seam
 * WITHOUT any live Bedrock: `buildUserContent` is a pure content-builder, and the
 * LLM call itself goes through an injected fake `llmFn`, mirroring the repo's
 * "NO live Bedrock in tests" convention.
 */
import { describe, expect, it } from "bun:test";
import {
  buildUserContent,
  type LlmFn,
  type LlmCallInput,
  type LlmCallResult,
} from "../src/core/llm/haiku.ts";
import { generateChunkContext } from "../src/core/search/contextual-llm.ts";
import { BudgetTracker, costUsd } from "../src/core/budget.ts";

/** Fake utility LLM that records each call and returns a canned result. Ignores
 *  the caching split entirely — a stand-in for any client, cache-aware or not. */
function fakeLlm(
  result: Partial<LlmCallResult> & { text: string },
  seen: LlmCallInput[] = [],
): { fn: LlmFn; seen: LlmCallInput[] } {
  const fn: LlmFn = (input) => {
    seen.push(input);
    return Promise.resolve({
      text: result.text,
      modelId: result.modelId ?? "eu.anthropic.claude-haiku-fake",
      ...(result.usage ? { usage: result.usage } : {}),
    });
  };
  return { fn, seen };
}

describe("buildUserContent — cachePoint placement", () => {
  it("puts the cachePoint AFTER the document block and BEFORE the chunk tail", () => {
    const input: LlmCallInput = {
      system: "sys",
      user: "<chunk>\nc\n</chunk>",
      cachePrefix: "<document>\nd\n</document>",
      maxTokens: 120,
    };
    const content = buildUserContent(input, true);
    expect(content.length).toBe(3);
    expect(content[0]).toEqual({ text: "<document>\nd\n</document>" });
    expect(content[1]).toEqual({ cachePoint: { type: "default" } });
    expect(content[2]).toEqual({ text: "<chunk>\nc\n</chunk>" });
  });

  it("fail-safe: no cachePoint when caching is disabled — one merged block", () => {
    const input: LlmCallInput = {
      system: "sys",
      user: "<chunk>\nc\n</chunk>",
      cachePrefix: "<document>\nd\n</document>",
      maxTokens: 120,
    };
    const content = buildUserContent(input, false);
    expect(content.length).toBe(1);
    // Merged form is byte-identical to the split read top-to-bottom.
    expect(content[0]).toEqual({
      text: "<document>\nd\n</document>\n\n<chunk>\nc\n</chunk>",
    });
    // No cachePoint anywhere in the fallback content.
    expect(content.some((b) => "cachePoint" in b)).toBe(false);
  });

  it("plain call (no cachePrefix) stays a single text block", () => {
    const content = buildUserContent({ system: "s", user: "u", maxTokens: 10 }, true);
    expect(content).toEqual([{ text: "u" }]);
  });
});

describe("generateChunkContext — document caching", () => {
  it("marks the document as the cacheable prefix, chunk tail stays uncached", async () => {
    const { fn, seen } = fakeLlm({ text: "situated" });
    const ctx = await generateChunkContext(
      "Full doc about hybrid retrieval.",
      "RRF blends the two rankings.",
      { llmFn: fn, cacheDocument: true },
    );
    expect(ctx).toBe("situated");
    expect(seen.length).toBe(1);
    // The document is the cache prefix...
    expect(seen[0]!.cachePrefix).toContain("<document>");
    expect(seen[0]!.cachePrefix).toContain("Full doc about hybrid retrieval");
    // ...and it must NOT leak into the (uncached) per-chunk tail.
    expect(seen[0]!.cachePrefix).not.toContain("<chunk>");
    expect(seen[0]!.user).toContain("<chunk>");
    expect(seen[0]!.user).toContain("RRF blends the two rankings");
    expect(seen[0]!.user).not.toContain("<document>");
  });

  it("consecutive chunks of the SAME document reuse an identical cached prefix", async () => {
    const seen: LlmCallInput[] = [];
    const { fn } = fakeLlm({ text: "ctx" }, seen);
    const doc = "Section one. Section two. Section three.";
    await generateChunkContext(doc, "chunk one text", { llmFn: fn, cacheDocument: true });
    await generateChunkContext(doc, "a different chunk two", { llmFn: fn, cacheDocument: true });

    expect(seen.length).toBe(2);
    // Same doc → byte-identical cache prefix → the cache is written once, read back.
    expect(seen[0]!.cachePrefix).toBe(seen[1]!.cachePrefix);
    expect(seen[0]!.cachePrefix).toContain("<document>");
    // The uncached tails differ per chunk.
    expect(seen[0]!.user).not.toBe(seen[1]!.user);
  });

  it("without cacheDocument the call is a single combined block (no cachePrefix)", async () => {
    const { fn, seen } = fakeLlm({ text: "ctx" });
    await generateChunkContext("doc text", "chunk text", { llmFn: fn });
    expect(seen[0]!.cachePrefix).toBeUndefined();
    expect(seen[0]!.user).toContain("<document>");
    expect(seen[0]!.user).toContain("<chunk>");
  });

  it("fail-safe: a cache-agnostic client still returns a correct context", async () => {
    // This fake ignores the caching split entirely (as an uncached client would),
    // yet the tier still yields the model's context — caching never gates output.
    const { fn } = fakeLlm({ text: "still works" });
    const ctx = await generateChunkContext("doc", "chunk", {
      llmFn: fn,
      cacheDocument: true,
    });
    expect(ctx).toBe("still works");
  });
});

describe("generateChunkContext — budget records cache usage", () => {
  const HAIKU = "eu.anthropic.claude-haiku-4-5-20251001-v1:0";

  it("folds cacheRead/cacheWrite into the recorded spend (discounted vs uncached)", async () => {
    const usage = {
      inputTokens: 200,
      outputTokens: 60,
      cacheReadInputTokens: 20000,
      cacheWriteInputTokens: 8000,
    };
    const { fn } = fakeLlm({ text: "ctx", modelId: HAIKU, usage });
    const budget = new BudgetTracker(100, "cache-test");
    const ctx = await generateChunkContext("doc", "chunk", {
      llmFn: fn,
      cacheDocument: true,
      budget,
      modelId: HAIKU,
    });
    expect(ctx).toBe("ctx");

    // Cache read ~10% + cache write ~125% of the input rate, folded into an
    // effective input-token count: 200 + 8000*1.25 + 20000*0.1 = 12200.
    const expected = costUsd(HAIKU, { inputTokens: 12200, outputTokens: 60 });
    expect(budget.totalSpent()).toBeCloseTo(expected, 8);

    // Strictly cheaper than pricing every token as uncached input.
    const naive = costUsd(HAIKU, { inputTokens: 200 + 8000 + 20000, outputTokens: 60 });
    expect(budget.totalSpent()).toBeLessThan(naive);
  });

  it("no reported usage → falls back to a size estimate (still records spend)", async () => {
    const { fn } = fakeLlm({ text: "ctx", modelId: HAIKU }); // no usage field
    const budget = new BudgetTracker(100, "cache-test");
    await generateChunkContext("doc text here", "chunk text here", {
      llmFn: fn,
      cacheDocument: true,
      budget,
      modelId: HAIKU,
    });
    expect(budget.totalSpent()).toBeGreaterThan(0);
  });
});
