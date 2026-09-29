/**
 * Seeded bootstrap intervals — the statistics layer under eval, eval gate,
 * eval-replay, eval-probe and doctor. Pure; no DB.
 */
import { describe, expect, it } from "bun:test";
import {
  bootstrapMeanCI,
  pairedBootstrapDeltaCI,
  mulberry32,
  METRIC_GLOSSARY,
} from "../src/core/search/bootstrap.ts";

const noisy = [1, 0, 1, 1, 0.5, 0.333, 1, 0, 0.25];

describe("mulberry32", () => {
  it("is deterministic per seed and stays in [0, 1)", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 100; i++) {
      const x = a();
      expect(x).toBe(b());
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });
});

describe("bootstrapMeanCI", () => {
  it("gives an identical interval for an identical seed", () => {
    expect(bootstrapMeanCI(noisy)).toEqual(bootstrapMeanCI(noisy));
    expect(bootstrapMeanCI(noisy).seed).toBe(42);
  });

  it("gives a different but overlapping interval for another seed", () => {
    // Continuous scores: with few distinct values two seeds can land on the
    // same percentile resample.
    const scores = Array.from({ length: 30 }, (_, i) => ((i * 37) % 101) / 101);
    const a = bootstrapMeanCI(scores, { seed: 42 });
    const b = bootstrapMeanCI(scores, { seed: 7 });
    expect([a.lo, a.hi]).not.toEqual([b.lo, b.hi]);
    expect(a.lo).toBeLessThanOrEqual(b.hi);
    expect(b.lo).toBeLessThanOrEqual(a.hi);
  });

  it("brackets the mean", () => {
    const r = bootstrapMeanCI(noisy);
    expect(r.lo).toBeLessThanOrEqual(r.mean);
    expect(r.mean).toBeLessThanOrEqual(r.hi);
    expect(r.lo).toBeLessThan(r.hi);
    expect(r.n).toBe(noisy.length);
  });

  it("defines the degenerate inputs", () => {
    expect(bootstrapMeanCI([])).toMatchObject({ mean: 0, lo: 0, hi: 0, n: 0 });
    expect(bootstrapMeanCI([0.7])).toMatchObject({ mean: 0.7, lo: 0.7, hi: 0.7, n: 1 });
    expect(bootstrapMeanCI([0.3, 0.3, 0.3])).toMatchObject({ mean: 0.3, lo: 0.3, hi: 0.3 });
  });

  it("costs O(iterations × n): 10x the queries takes roughly 10x the time", () => {
    const small = Array.from({ length: 2000 }, (_, i) => (i % 7) / 7);
    const large = Array.from({ length: 20000 }, (_, i) => (i % 7) / 7);
    bootstrapMeanCI(small, { iterations: 200 }); // warm-up
    const t0 = performance.now();
    bootstrapMeanCI(small, { iterations: 200 });
    const t1 = performance.now();
    bootstrapMeanCI(large, { iterations: 200 });
    const t2 = performance.now();
    const ratio = (t2 - t1) / Math.max(t1 - t0, 0.05);
    // Linear growth is ~10; a quadratic step would be ~100.
    expect(ratio).toBeLessThan(40);
  });
});

describe("pairedBootstrapDeltaCI", () => {
  it("throws on a length mismatch", () => {
    expect(() => pairedBootstrapDeltaCI([1, 2], [1])).toThrow(/length mismatch/);
  });

  it("puts a consistent per-query drop entirely below 0", () => {
    const before = noisy.map((v) => v + 0.5);
    const r = pairedBootstrapDeltaCI(before, noisy);
    expect(r.mean).toBeCloseTo(-0.5, 9);
    expect(r.hi).toBeLessThan(0);
  });

  it("lets symmetric noise straddle 0", () => {
    const before = [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5];
    const after = [0.6, 0.4, 0.7, 0.3, 0.55, 0.45, 0.8, 0.2];
    const r = pairedBootstrapDeltaCI(before, after);
    expect(r.lo).toBeLessThan(0);
    expect(r.hi).toBeGreaterThan(0);
  });

  it("gives exactly [0, 0] for identical runs", () => {
    const r = pairedBootstrapDeltaCI(noisy, [...noisy]);
    expect([r.lo, r.hi]).toEqual([0, 0]);
  });
});

describe("METRIC_GLOSSARY", () => {
  it("names every metric the eval and replay reports emit", () => {
    const emitted = [
      "meanRecall",
      "meanReciprocalRank",
      "hitRate",
      "meanNdcg",
      "meanPrecision",
      "wilsonCi95",
      "recallCi95",
      "mrrCi95",
      "run_config_hash",
      "qrels_sha256",
      "meanRR",
      "meanRRCi95",
      "hitRateCi95",
      "deltaMeanRRCi95",
      "deltaHitRateCi95",
      "significantDrop",
      "delta_ci95",
      "qrels_changed",
      "recall_ci95",
      "mrr_ci95",
      "ndcg",
      "precision",
    ];
    for (const key of emitted) expect(METRIC_GLOSSARY[key]).toBeString();
  });
});
