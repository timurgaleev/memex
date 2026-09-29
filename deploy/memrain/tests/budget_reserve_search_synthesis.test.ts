/**
 * The search and synthesis paid sites hold their estimate before awaiting the
 * model, so callers sharing one BudgetTracker cannot all pass the same headroom.
 *
 * Locks, for graph rerank and the relational LLM arm: N parallel calls against
 * a small cap admit exactly floor(cap / estimate); a thrown call gives its hold
 * back.
 */
import { describe, expect, it } from "bun:test";
import { BudgetTracker, costUsd } from "../src/core/budget.ts";
import type { SonnetFn, SonnetUsage } from "../src/core/llm/sonnet.ts";
import type { SearchHit } from "../src/core/search/hybrid.ts";
import type { Storage } from "../src/core/storage.ts";
import { graphRerank } from "../src/core/search/graph-rerank.ts";
import { relationalRecallLlm } from "../src/core/search/relational-llm.ts";

const HAIKU = "eu.anthropic.claude-haiku-4-5-20251001-v1:0";
const SMALL_USAGE = { inputTokens: 10, outputTokens: 10 };

/** Remembers the last estimate a site held, so a cap can be sized from it. */
class EstimateSpy extends BudgetTracker {
  lastEstimateUsd = 0;
  override reserve(modelId: string, estUsage: SonnetUsage) {
    this.lastEstimateUsd = costUsd(modelId, estUsage);
    return super.reserve(modelId, estUsage);
  }
}

function slowSonnet(text: string) {
  let calls = 0;
  const fn: SonnetFn = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 5));
    return { text, modelId: HAIKU, usage: SMALL_USAGE, stopReason: "end_turn" };
  };
  return { fn, calls: () => calls };
}

const failingSonnet: SonnetFn = async () => {
  throw new Error("down");
};

function hit(i: number): SearchHit {
  return {
    chunkId: `c-${i}`,
    documentId: `d-${i}`,
    sourcePath: `notes/n${i}.md`,
    title: `n${i}`,
    content: `candidate ${i}`,
    score: 1 - i / 10,
    intent: "topic",
  };
}

const HITS = [hit(0), hit(1), hit(2)];

interface Site {
  name: string;
  okText: string;
  run: (budget: BudgetTracker, sonnetFn: SonnetFn) => Promise<unknown>;
}

const SITES: Site[] = [
  {
    name: "graph rerank",
    okText: "[2,1,0]",
    run: (budget, sonnetFn) =>
      graphRerank("which note", HITS, {
        sonnetFn,
        budget,
        modelId: HAIKU,
        degreeFn: async () => new Map(),
      }),
  },
  {
    name: "relational LLM arm",
    // Invalid output returns before the fanout, so no storage is touched.
    okText: "not json",
    run: (budget, sonnetFn) =>
      relationalRecallLlm({} as Storage, "who works with alice", { sonnetFn, budget, modelId: HAIKU }),
  },
];

async function estimateFor(site: Site): Promise<number> {
  const spy = new EstimateSpy(1_000, "probe");
  await site.run(spy, slowSonnet(site.okText).fn);
  expect(spy.lastEstimateUsd).toBeGreaterThan(0);
  return spy.lastEstimateUsd;
}

for (const site of SITES) {
  describe(`${site.name} on one shared tracker`, () => {
    for (const admitted of [0, 1, 3]) {
      it(`admits exactly floor(cap / estimate) = ${admitted} of 12 parallel calls`, async () => {
        const est = await estimateFor(site);
        const cap = est * (admitted + 0.5);
        const budget = new BudgetTracker(cap, "test");
        const { fn, calls } = slowSonnet(site.okText);
        await Promise.all(Array.from({ length: 12 }, () => site.run(budget, fn)));
        expect(calls()).toBe(admitted);
        expect(budget.totalSpent()).toBeLessThanOrEqual(cap);
      });
    }

    it("gives a thrown call's hold back", async () => {
      const est = await estimateFor(site);
      const budget = new EstimateSpy(est * 1.5, "test");
      await site.run(budget, failingSonnet);
      expect(budget.totalSpent()).toBe(0);
      const { fn, calls } = slowSonnet(site.okText);
      await site.run(budget, fn);
      expect(calls()).toBe(1);
    });
  });
}
