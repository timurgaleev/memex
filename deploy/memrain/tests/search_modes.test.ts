/**
 * `memex search modes` — read-only ranking-config view. Pure (no storage, no
 * search); asserts it surfaces the resolved knobs + intent taxonomy and tracks
 * env overrides.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { buildSearchModes } from "../src/commands/search-modes.ts";

const ENV_KEYS = [
  "MEMEX_TITLE_BOOST",
  "MEMEX_NEARDUP_JACCARD",
  "MEMEX_RERANK",
  "MEMEX_QUERY_CACHE",
];
const saved: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("search modes", () => {
  it("lists the intent taxonomy and the heuristic rules", () => {
    const m = buildSearchModes();
    expect(m.ok).toBe(true);
    expect(m.intents).toEqual(
      expect.arrayContaining(["factual", "topic", "howto", "personal", "exact"]),
    );
    expect(m.intent_heuristics.exact).toMatch(/quote/i);
    expect(m.intent_heuristics.howto).toMatch(/how/);
  });

  it("surfaces every ranking knob with its env var", () => {
    const m = buildSearchModes();
    expect((m.knobs.title_boost as { env: string }).env).toBe("MEMEX_TITLE_BOOST");
    expect((m.knobs.recency_decay as { env: string }).env).toBe("MEMEX_RECENCY_DECAY");
    expect((m.knobs.neardup_jaccard as { env: string }).env).toBe("MEMEX_NEARDUP_JACCARD");
    expect((m.knobs.rerank as { env: string }).env).toBe("MEMEX_RERANK");
    expect((m.knobs.query_cache as { env: string }).env).toBe("MEMEX_QUERY_CACHE");
    expect(typeof m.ranking_signature).toBe("string");
  });

  it("reflects env overrides in the resolved knob values", () => {
    process.env["MEMEX_RERANK"] = "1";
    process.env["MEMEX_QUERY_CACHE"] = "0";
    const m = buildSearchModes();
    expect((m.knobs.rerank as { enabled: boolean }).enabled).toBe(true);
    expect((m.knobs.query_cache as { enabled: boolean }).enabled).toBe(false);
  });

  it("defaults rerank off and query_cache on with no env set", () => {
    delete process.env["MEMEX_RERANK"];
    delete process.env["MEMEX_QUERY_CACHE"];
    const m = buildSearchModes();
    expect((m.knobs.rerank as { enabled: boolean }).enabled).toBe(false);
    expect((m.knobs.query_cache as { enabled: boolean }).enabled).toBe(true);
  });
});
