/**
 * Search mode bundles + knob resolution + knobs-hash cache signature.
 * Pure env-driven logic — no DB, no Bedrock.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
  MODE_BUNDLES,
  DEFAULT_SEARCH_MODE,
  resolveSearchMode,
  resolveKnob,
} from "../src/core/search/mode.ts";
import {
  resolveSearchKnobs,
  knobsCacheSuffix,
} from "../src/core/search/hybrid.ts";
import { rankingSignature, queryCacheKey } from "../src/core/search/query-cache.ts";

const ENV_KEYS = [
  "MEMEX_SEARCH_MODE",
  "MEMEX_RERANK",
  "MEMEX_QUERY_EXPANSION",
  "MEMEX_GRAPH_SIGNALS",
  "MEMEX_COSINE_RESCORE",
  "MEMEX_RELATIONAL_ARM",
  "MEMEX_BACKLINK_BOOST",
];
const saved: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
const clearAll = () => {
  for (const k of ENV_KEYS) delete process.env[k];
};

describe("mode bundles", () => {
  it("defaults to conservative — memex's historical all-OFF posture", () => {
    clearAll();
    expect(DEFAULT_SEARCH_MODE).toBe("conservative");
    expect(resolveSearchMode()).toBe("conservative");
    const b = MODE_BUNDLES.conservative;
    expect(b.expansion).toBe(false);
    expect(b.rerank).toBe(false);
    expect(b.graphSignals).toBe(false);
    expect(b.cosineRescore).toBe(false);
    expect(b.relationalArm).toBe(false);
    expect(b.tokenBudget).toBeUndefined();
  });

  it("balanced turns the deterministic + rerank stages on with a 12k cap", () => {
    const b = MODE_BUNDLES.balanced;
    expect(b.rerank).toBe(true);
    expect(b.graphSignals).toBe(true);
    expect(b.relationalArm).toBe(true);
    expect(b.cosineRescore).toBe(true);
    expect(b.expansion).toBe(false); // negligible measured lift → off
    expect(b.tokenBudget).toBe(12_000);
  });

  it("tokenmax enables expansion and drops the cap", () => {
    const b = MODE_BUNDLES.tokenmax;
    expect(b.expansion).toBe(true);
    expect(b.tokenBudget).toBeUndefined();
  });

  it("unknown mode env falls back to conservative", () => {
    process.env.MEMEX_SEARCH_MODE = "warp-speed";
    expect(resolveSearchMode()).toBe("conservative");
    process.env.MEMEX_SEARCH_MODE = "BALANCED";
    expect(resolveSearchMode()).toBe("balanced"); // case-insensitive
  });
});

describe("resolveKnob chain (per-call > env > bundle)", () => {
  it("per-call wins over env and bundle", () => {
    expect(resolveKnob(false, "1", true)).toBe(false);
    expect(resolveKnob(true, "0", false)).toBe(true);
  });
  it("explicit env 1/0 wins over the bundle", () => {
    expect(resolveKnob(undefined, "1", false)).toBe(true);
    expect(resolveKnob(undefined, "0", true)).toBe(false);
  });
  it("unset/garbage env falls through to the bundle", () => {
    expect(resolveKnob(undefined, undefined, true)).toBe(true);
    expect(resolveKnob(undefined, "yes", false)).toBe(false);
  });
});

describe("resolveSearchKnobs (hybridSearch resolution)", () => {
  it("default: everything off, expansion off, backlink on, no budget", () => {
    clearAll();
    const kn = resolveSearchKnobs({});
    expect(kn.rerankWanted).toBe(false);
    expect(kn.expansionEnabled).toBe(false); // G15: default OFF
    expect(kn.graphSignalsOn).toBe(false);
    expect(kn.cosineRescoreOn).toBe(false);
    expect(kn.relationalArmOn).toBe(false);
    expect(kn.backlinkBoostOn).toBe(true);
    expect(kn.tokenBudget).toBeUndefined();
  });

  it("MEMEX_QUERY_EXPANSION is the expansion kill-switch/enable", () => {
    clearAll();
    process.env.MEMEX_QUERY_EXPANSION = "1";
    expect(resolveSearchKnobs({}).expansionEnabled).toBe(true);
    process.env.MEMEX_SEARCH_MODE = "tokenmax";
    process.env.MEMEX_QUERY_EXPANSION = "0"; // kill-switch beats the bundle
    expect(resolveSearchKnobs({}).expansionEnabled).toBe(false);
  });

  it("the hermetic expandQueryFn seam implies expansion on (unless vetoed)", () => {
    clearAll();
    const fn = async () => ["x"];
    expect(resolveSearchKnobs({ expandQueryFn: fn }).expansionEnabled).toBe(true);
    expect(
      resolveSearchKnobs({ expandQueryFn: fn, noExpansion: true }).expansionEnabled,
    ).toBe(false);
  });

  it("mode bundle supplies defaults; per-knob env still overrides", () => {
    clearAll();
    process.env.MEMEX_SEARCH_MODE = "balanced";
    const kn = resolveSearchKnobs({});
    expect(kn.rerankWanted).toBe(true);
    expect(kn.graphSignalsOn).toBe(true);
    expect(kn.tokenBudget).toBe(12_000);
    process.env.MEMEX_GRAPH_SIGNALS = "0";
    expect(resolveSearchKnobs({}).graphSignalsOn).toBe(false);
  });
});

describe("knobs-hash in the cache signature (G14/G25)", () => {
  it("rankingSignature changes when MEMEX_GRAPH_SIGNALS / MEMEX_COSINE_RESCORE flip", () => {
    clearAll();
    const base = rankingSignature();
    process.env.MEMEX_GRAPH_SIGNALS = "1";
    const gs = rankingSignature();
    expect(gs).not.toBe(base);
    delete process.env.MEMEX_GRAPH_SIGNALS;
    process.env.MEMEX_COSINE_RESCORE = "1";
    expect(rankingSignature()).not.toBe(base);
    delete process.env.MEMEX_COSINE_RESCORE;
    expect(rankingSignature()).toBe(base);
  });

  it("rankingSignature changes when MEMEX_RERANK_WINDOW is set", () => {
    clearAll();
    const base = rankingSignature();
    process.env.MEMEX_RERANK_WINDOW = "50";
    expect(rankingSignature()).not.toBe(base);
    delete process.env.MEMEX_RERANK_WINDOW;
    expect(rankingSignature()).toBe(base);
  });

  it("rankingSignature changes when the mode flips", () => {
    clearAll();
    const base = rankingSignature();
    process.env.MEMEX_SEARCH_MODE = "balanced";
    expect(rankingSignature()).not.toBe(base);
  });

  it("per-call resolved knobs re-key the cache via the suffix", () => {
    clearAll();
    const off = knobsCacheSuffix(resolveSearchKnobs({}));
    const on = knobsCacheSuffix(resolveSearchKnobs({ graphSignals: true }));
    expect(on).not.toBe(off);
    const kOff = queryCacheKey("q", 5, undefined, false, rankingSignature() + off);
    const kOn = queryCacheKey("q", 5, undefined, false, rankingSignature() + on);
    expect(kOn).not.toBe(kOff);
  });

  it("tenant scope participates in the cache key (verified, pre-existing)", () => {
    clearAll();
    const unscoped = queryCacheKey("q", 5, undefined, false);
    const scopedA = queryCacheKey("q", 5, ["src-a"], false);
    const scopedB = queryCacheKey("q", 5, ["src-b"], false);
    expect(scopedA).not.toBe(unscoped);
    expect(scopedA).not.toBe(scopedB);
    // Order-independent within one scope set.
    expect(queryCacheKey("q", 5, ["a", "b"], false)).toBe(
      queryCacheKey("q", 5, ["b", "a"], false),
    );
  });
});
