/**
 * Conversation→facts extractor: budget tracker, response parser, and the
 * end-to-end command with a stubbed Sonnet model (no Bedrock). PGLite storage.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import {
  BudgetTracker,
  BudgetExhausted,
  costUsd,
  priceFor,
} from "../src/core/budget.ts";
import { parseFactsResponse, slugifyEntity } from "../src/core/facts-extract.ts";
import { runExtractConversationFacts } from "../src/commands/extract-conversation-facts.ts";
import { listFacts } from "../src/core/facts.ts";
import type { SonnetFn } from "../src/core/llm/sonnet.ts";

setDefaultTimeout(25000);

describe("budget pricing", () => {
  it("prices sonnet and haiku per 1M tokens", () => {
    expect(priceFor("eu.anthropic.claude-sonnet-4-6-v1:0")).toEqual({
      inputPer1M: 3.0,
      outputPer1M: 15.0,
    });
    expect(priceFor("eu.anthropic.claude-haiku-4-5-v1:0")).toEqual({
      inputPer1M: 1.0,
      outputPer1M: 5.0,
    });
    expect(priceFor("global.amazon.nova-2-lite-v1:0")).toBeNull();
    expect(costUsd("sonnet", { inputTokens: 1_000_000, outputTokens: 0 })).toBeCloseTo(3.0, 6);
  });

  it("throws BudgetExhausted at the cap and on unpriced models", () => {
    const b = new BudgetTracker(0.001, "test");
    expect(() =>
      b.record("sonnet", { inputTokens: 100, outputTokens: 50 }),
    ).toThrow(BudgetExhausted); // 0.00105 > 0.001
    const b2 = new BudgetTracker(1.0, "test");
    expect(() =>
      b2.record("nova-lite", { inputTokens: 10, outputTokens: 10 }),
    ).toThrow(/no pricing/);
  });

  it("accumulates under the cap without throwing", () => {
    const b = new BudgetTracker(1.0, "test");
    b.record("sonnet", { inputTokens: 1000, outputTokens: 500 });
    expect(b.totalSpent()).toBeGreaterThan(0);
    expect(b.snapshot().callsRecorded).toBe(1);
  });
});

describe("parseFactsResponse", () => {
  it("parses a valid facts object and clamps confidence", () => {
    const facts = parseFactsResponse(
      '{"facts":[{"fact":"Alice loves coffee","kind":"preference","entity":"Alice","confidence":1.4,"notability":"high"}]}',
    );
    expect(facts).toHaveLength(1);
    expect(facts[0]).toEqual({
      fact: "Alice loves coffee",
      kind: "preference",
      entity: "Alice",
      confidence: 1,
      notability: "high",
    });
  });
  it("strips a code fence and tolerates garbage", () => {
    expect(parseFactsResponse('```json\n{"facts":[]}\n```')).toEqual([]);
    expect(parseFactsResponse("not json")).toEqual([]);
  });
  it("slugifies entity names", () => {
    expect(slugifyEntity("Alice Example")).toBe("alice-example");
    expect(slugifyEntity("  !!  ")).toBeNull();
  });
});

describe("runExtractConversationFacts (stubbed model)", () => {
  const dbDir = mkdtempSync(join(tmpdir(), "tb-facts-extract-"));
  let storage: Storage;

  // Canned model: one preference fact about the speaker, fixed usage.
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

  beforeAll(async () => {
    storage = new Storage({ dbPath: join(dbDir, "brain.pglite") });
    await storage.init();
  });
  afterAll(async () => {
    await storage.close();
    rmSync(dbDir, { recursive: true, force: true });
  });

  it("extracts facts from each turn and writes them to entity_facts", async () => {
    const transcript = "Alice: I really enjoy a cup of tea\nBob: me too, every morning";
    const report = await runExtractConversationFacts(storage, {
      text: transcript,
      sourceSlug: "chat-log",
      maxBudgetUsd: 1.0,
      sonnetFn: stub,
    });
    expect(report.ran).toBe(true);
    expect(report.turns).toBe(2);
    expect(report.factsWritten).toBe(2);
    expect(report.budgetExhausted).toBe(false);
    expect(report.spentUsd).toBeGreaterThan(0);

    const aliceFacts = await listFacts(storage, "alice");
    expect(aliceFacts.some((f) => f.fact === "Alice likes tea")).toBe(true);
  });

  it("stops before spending when the budget is too small (strict pre-ceiling)", async () => {
    const report = await runExtractConversationFacts(storage, {
      text: "Carol: I like tea\nDave: I like tea\nEve: I like tea",
      maxBudgetUsd: 0.0005, // below the worst-case per-call cost → pre-flight stops
      sonnetFn: stub,
    });
    expect(report.ran).toBe(true);
    expect(report.budgetExhausted).toBe(true);
    // Pre-flight guard fires before the first paid call — nothing dispatched.
    expect(report.factsWritten).toBe(0);
    expect(report.spentUsd).toBe(0);
  });

  it("is default-OFF without the env gate and no injected model", async () => {
    const report = await runExtractConversationFacts(storage, {
      text: "Frank: hi",
      maxBudgetUsd: 1.0,
    });
    expect(report.ran).toBe(false);
    expect(report.reason).toMatch(/MEMEX_FACTS_EXTRACTION/);
  });
});
