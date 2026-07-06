/**
 * Search telemetry (migration 089) — rollup writer + stats reader + the
 * tune recommendation engine. Pins: ON CONFLICT accumulation across flushes,
 * evidence-band mapping, windowed aggregation, and the observe→recommend→
 * apply loop writing through runtime_config.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import {
  getTelemetryWriter,
  recordSearchTelemetry,
  readSearchStats,
  _resetTelemetryWriterForTest,
  type TelemetryHit,
} from "../src/core/search/telemetry.ts";
import {
  buildTuneRecommendations,
  applyTuneRecommendation,
  buildRevertCommand,
} from "../src/commands/search-stats.ts";
import { getRuntimeConfig } from "../src/core/runtime-config.ts";
import type { StatsWindow } from "../src/core/search/telemetry.ts";

const dir = mkdtempSync(join(tmpdir(), "memex-telemetry-"));
let storage: Storage;

beforeAll(async () => {
  storage = new Storage({ dbPath: join(dir, "db") });
  await storage.init();
});

afterAll(async () => {
  await storage.close();
  rmSync(dir, { recursive: true, force: true });
});

// The writer is a module singleton bound to the FIRST engine it sees — an
// earlier test file's hybridSearch may have bound (and since closed) its own
// engine in this process, so reset around every case here.
beforeEach(() => {
  _resetTelemetryWriterForTest();
});

afterEach(() => {
  _resetTelemetryWriterForTest();
});

function hit(content: string, score: number, evidence?: TelemetryHit["evidence"]): TelemetryHit {
  return { content, score, ...(evidence ? { evidence } : {}) };
}

describe("telemetry writer", () => {
  it("accumulates across flushes via ON CONFLICT and maps evidence bands", async () => {
    const e = storage.engine();
    await e.query("DELETE FROM search_telemetry");

    recordSearchTelemetry(e, { mode: "conservative", intent: "topic", cache: "miss" }, [
      hit("a".repeat(400), 0.9, "exact_title_match"),
      hit("b".repeat(400), 0.5),
    ]);
    await getTelemetryWriter().flush();

    recordSearchTelemetry(e, { mode: "conservative", intent: "topic", cache: "hit" }, [
      hit("c".repeat(40), 0.4, "keyword_exact"),
    ], 3);
    recordSearchTelemetry(e, { mode: "conservative", intent: "topic", cache: "off" }, [
      hit("d", 0.1, "weak_semantic"),
    ]);
    await getTelemetryWriter().flush();

    const { rows } = await e.query<{
      count: number;
      sum_results: number;
      cache_hit: number;
      cache_miss: number;
      sum_budget_dropped: number;
      count_rank1: number;
      rank1_high: number;
      rank1_solid: number;
      rank1_lt_solid: number;
    }>(
      `SELECT count, sum_results, cache_hit, cache_miss, sum_budget_dropped,
              count_rank1, rank1_high, rank1_solid, rank1_lt_solid
         FROM search_telemetry WHERE mode = 'conservative' AND intent = 'topic'`,
    );
    expect(rows.length).toBe(1);
    const r = rows[0]!;
    expect(r.count).toBe(3);
    expect(r.sum_results).toBe(4);
    expect(r.cache_hit).toBe(1);
    expect(r.cache_miss).toBe(1); // "off" bumps neither counter
    expect(r.sum_budget_dropped).toBe(3);
    expect(r.count_rank1).toBe(3);
    expect(r.rank1_high).toBe(1);
    expect(r.rank1_solid).toBe(1);
    expect(r.rank1_lt_solid).toBe(1);
  });

  it("readSearchStats derives averages + distributions over the window", async () => {
    const e = storage.engine();
    const stats = await readSearchStats(e, { days: 7 });
    expect(stats.total_calls).toBe(3);
    expect(stats.cache_hits).toBe(1);
    expect(stats.cache_misses).toBe(1);
    expect(stats.cache_hit_rate).toBeCloseTo(0.5);
    expect(stats.avg_results).toBeCloseTo(4 / 3);
    expect(stats.mode_distribution["conservative"]).toBe(3);
    expect(stats.intent_distribution["topic"]).toBe(3);
    expect(stats.rank1_count).toBe(3);
    expect(stats.avg_rank1_score).toBeCloseTo((0.9 + 0.4 + 0.1) / 3);
  });

  it("read failure degrades to empty stats, never throws", async () => {
    const stub = {
      query: async () => {
        throw new Error("boom");
      },
    } as unknown as Parameters<typeof readSearchStats>[0];
    const stats = await readSearchStats(stub, { days: 7 });
    expect(stats.total_calls).toBe(0);
    expect(stats.avg_rank1_score).toBeNull();
  });
});

function statsWith(over: Partial<StatsWindow>): StatsWindow {
  return {
    total_calls: 100,
    cache_hits: 10,
    cache_misses: 90,
    cache_hit_rate: 0.1,
    avg_results: 5,
    avg_tokens: 800,
    total_budget_dropped: 0,
    intent_distribution: {},
    mode_distribution: {},
    window_days: 7,
    avg_rank1_score: 0.5,
    rank1_count: 100,
    rank1_distribution: { lt_solid: 10, solid: 50, high: 40 },
    ...over,
  };
}

describe("search tune", () => {
  it("recommends leaving tokenmax (paid expansion) for balanced", () => {
    const recs = buildTuneRecommendations(statsWith({}), "tokenmax", {});
    expect(recs.some((r) => r.apply_command === "memex config set MEMEX_SEARCH_MODE balanced")).toBe(true);
  });

  it("flags budget pressure on a capped mode", () => {
    const recs = buildTuneRecommendations(
      statsWith({ total_budget_dropped: 500 }),
      "balanced",
      {},
    );
    expect(recs.some((r) => r.knob === "MEMEX_SEARCH_MODE" && r.suggested === "tokenmax")).toBe(true);
  });

  it("suggests re-enabling a killed query cache; conservative default stays quiet", () => {
    const on = buildTuneRecommendations(statsWith({}), "conservative", {
      MEMEX_QUERY_CACHE: "0",
    });
    expect(on.some((r) => r.apply_command === "memex config unset MEMEX_QUERY_CACHE")).toBe(true);
    const quiet = buildTuneRecommendations(statsWith({}), "conservative", {});
    expect(quiet).toEqual([]);
  });

  it("raises the semantic similarity floor only when the arm is on and hot", () => {
    const hot = statsWith({
      cache_hit_rate: 0.9,
      cache_hits: 90,
      cache_misses: 10,
    });
    const on = buildTuneRecommendations(hot, "conservative", {
      MEMEX_QUERY_CACHE_SEMANTIC: "1",
    });
    expect(on.some((r) => r.knob === "MEMEX_QUERY_CACHE_SIM")).toBe(true);
    const off = buildTuneRecommendations(hot, "conservative", {});
    expect(off.some((r) => r.knob === "MEMEX_QUERY_CACHE_SIM")).toBe(false);
  });

  it("--apply writes through runtime_config and the revert restores", async () => {
    const e = storage.engine();
    const rec = {
      knob: "MEMEX_SEARCH_MODE",
      current: "tokenmax",
      suggested: "balanced",
      reason: "test",
      apply_command: "memex config set MEMEX_SEARCH_MODE balanced",
    };
    await applyTuneRecommendation(e, rec);
    expect(await getRuntimeConfig(e, "MEMEX_SEARCH_MODE")).toBe("balanced");
    expect(buildRevertCommand(rec)).toBe("memex config set MEMEX_SEARCH_MODE tokenmax");
    // unset-shaped apply commands delete the row
    await applyTuneRecommendation(e, {
      ...rec,
      apply_command: "memex config unset MEMEX_SEARCH_MODE",
    });
    expect(await getRuntimeConfig(e, "MEMEX_SEARCH_MODE")).toBeNull();
  });
});
