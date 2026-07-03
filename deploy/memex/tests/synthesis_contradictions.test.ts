/**
 * Latent-contradiction probe (Item 3) — hermetic, injected SonnetFn (no
 * Bedrock). Covers the default-OFF gate, parse tolerance, cache, budget gate,
 * store-only-on-contradiction, and the MCP read (listProbedContradictions).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import type { Engine } from "../src/core/engine/interface.ts";
import {
  probeContradictionsPhase,
  parseJudgment,
  pairKey,
  type CandidatePair,
} from "../src/core/synthesis/contradictions.ts";
import { listProbedContradictions } from "../src/core/insights.ts";
import type { SonnetFn } from "../src/core/llm/sonnet.ts";
import { BudgetTracker } from "../src/core/budget.ts";

let tmp: string;
let storage: Storage;
let engine: Engine;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-contra-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  engine = storage.engine();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

const fakeSonnet = (text: string): SonnetFn => async () => ({
  text,
  modelId: "eu.anthropic.claude-sonnet-4-6",
  usage: { inputTokens: 100, outputTokens: 40 },
});

const pair = (a: string, b: string, source: string | null = "tenantA"): CandidatePair => ({
  a_ref: a,
  a_text: `claim ${a}`,
  b_ref: b,
  b_text: `claim ${b}`,
  source_id: source,
});

const CONTRADICTS = JSON.stringify({
  contradicts: true,
  severity: "high",
  axis: "value",
  confidence: 0.82,
  resolution_command: "forget_fact 2",
});

describe("parseJudgment", () => {
  it("parses a clean object and clamps confidence", () => {
    const j = parseJudgment(`{"contradicts":true,"severity":"medium","axis":"timing","confidence":1.4,"resolution_command":"x"}`);
    expect(j).not.toBeNull();
    expect(j!.contradicts).toBe(true);
    expect(j!.confidence).toBe(1);
    expect(j!.severity).toBe("medium");
  });
  it("defaults an unknown severity to low", () => {
    const j = parseJudgment(`{"contradicts":false,"severity":"nuclear","confidence":0.1}`);
    expect(j!.severity).toBe("low");
  });
  it("returns null when contradicts is missing", () => {
    expect(parseJudgment(`{"severity":"low"}`)).toBeNull();
    expect(parseJudgment("not json")).toBeNull();
  });
});

describe("probeContradictionsPhase", () => {
  it("is default-OFF without the flag and no injected sonnetFn", async () => {
    const prev = process.env.MEMEX_PROBE_CONTRADICTIONS;
    delete process.env.MEMEX_PROBE_CONTRADICTIONS;
    try {
      const r = await probeContradictionsPhase(engine, { pairsFn: async () => [pair("1", "2")] });
      expect(r.judged).toBe(0);
      expect(r.skippedReason).toContain("MEMEX_PROBE_CONTRADICTIONS");
    } finally {
      if (prev !== undefined) process.env.MEMEX_PROBE_CONTRADICTIONS = prev;
    }
  });

  it("stores a suspected contradiction and reads it back scoped", async () => {
    const r = await probeContradictionsPhase(engine, {
      sonnetFn: fakeSonnet(CONTRADICTS),
      pairsFn: async () => [pair("1", "2")],
    });
    expect(r.judged).toBe(1);
    expect(r.contradictionsFound).toBe(1);

    const found = await listProbedContradictions(storage, { sourceIds: ["tenantA"] });
    expect(found).toHaveLength(1);
    expect(found[0]!.severity).toBe("high");
    expect(found[0]!.axis).toBe("value");

    // A foreign tenant sees nothing (fail-closed scope).
    expect(await listProbedContradictions(storage, { sourceIds: ["other"] })).toHaveLength(0);
  });

  it("does NOT store a non-contradiction", async () => {
    const r = await probeContradictionsPhase(engine, {
      sonnetFn: fakeSonnet(JSON.stringify({ contradicts: false, severity: "low", confidence: 0.2 })),
      pairsFn: async () => [pair("1", "2")],
    });
    expect(r.judged).toBe(1);
    expect(r.contradictionsFound).toBe(0);
    expect(await listProbedContradictions(storage)).toHaveLength(0);
  });

  it("caches: a pair already stored is not re-judged", async () => {
    let calls = 0;
    const counting: SonnetFn = async () => {
      calls += 1;
      return { text: CONTRADICTS, modelId: "eu.anthropic.claude-sonnet-4-6", usage: { inputTokens: 10, outputTokens: 5 } };
    };
    const opts = { sonnetFn: counting, pairsFn: async () => [pair("1", "2")] };
    await probeContradictionsPhase(engine, opts);
    const r2 = await probeContradictionsPhase(engine, opts);
    expect(calls).toBe(1);
    expect(r2.cacheHits).toBe(1);
    expect(r2.judged).toBe(0);
  });

  it("stops before spending when the budget can't fit a pair", async () => {
    let called = false;
    const spy: SonnetFn = async () => {
      called = true;
      return { text: CONTRADICTS, modelId: "eu.anthropic.claude-sonnet-4-6", usage: { inputTokens: 1, outputTokens: 1 } };
    };
    const r = await probeContradictionsPhase(engine, {
      sonnetFn: spy,
      budget: new BudgetTracker(0.0000001, "probe-test"),
      pairsFn: async () => [pair("1", "2")],
    });
    expect(called).toBe(false);
    expect(r.budgetExhausted).toBe(true);
    expect(r.contradictionsFound).toBe(0);
  });

  it("pairKey is stable + order-sensitive", () => {
    expect(pairKey("1", "2", "v")).toBe(pairKey("1", "2", "v"));
    expect(pairKey("1", "2", "v")).not.toBe(pairKey("2", "1", "v"));
  });
});
