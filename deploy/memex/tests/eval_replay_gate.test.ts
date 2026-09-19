/**
 * eval-replay CI regression gate — the pure predicate + eps resolver, and the
 * paired bootstrap interval reported next to it. Hermetic: no Bedrock; the
 * interval cases replay a stub searcher over a PGLite eval set.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isReplayRegression,
  evalRegressionEps,
  regressionMessage,
  DEFAULT_EVAL_REGRESSION_EPS,
} from "../src/commands/eval-replay.ts";
import { Storage } from "../src/core/storage.ts";
import { recordQuery, replayAll } from "../src/core/eval-replay.ts";

const clean = { deltaMeanRR: 0, deltaHitRate: 0 };
const dropped = { deltaMeanRR: -0.2, deltaHitRate: -0.1 };
const tinyDrop = { deltaMeanRR: -0.005, deltaHitRate: 0 };

afterEach(() => {
  delete process.env.EVAL_REPLAY_REGRESSION_EPS;
});

describe("evalRegressionEps", () => {
  it("defaults when unset", () => {
    expect(evalRegressionEps(undefined)).toBe(DEFAULT_EVAL_REGRESSION_EPS);
    expect(evalRegressionEps("")).toBe(DEFAULT_EVAL_REGRESSION_EPS);
  });
  it("parses a valid override", () => {
    expect(evalRegressionEps("0.05")).toBe(0.05);
    expect(evalRegressionEps("0")).toBe(0);
  });
  it("falls back on garbage / negative", () => {
    expect(evalRegressionEps("nope")).toBe(DEFAULT_EVAL_REGRESSION_EPS);
    expect(evalRegressionEps("-1")).toBe(DEFAULT_EVAL_REGRESSION_EPS);
  });
});

describe("isReplayRegression", () => {
  it("no baseline → never a regression (first run)", () => {
    expect(isReplayRegression({})).toBe(false);
    expect(isReplayRegression({ baseline: undefined })).toBe(false);
  });

  it("a clean run (no drop) → not a regression", () => {
    expect(isReplayRegression({ baseline: clean })).toBe(false);
  });

  it("a meaningful drop below eps → regression", () => {
    expect(isReplayRegression({ baseline: dropped })).toBe(true);
  });

  it("a drop smaller than eps → absorbed as noise, not a regression", () => {
    expect(isReplayRegression({ baseline: tinyDrop })).toBe(false);
    // but a tighter eps catches it
    expect(isReplayRegression({ baseline: tinyDrop }, { eps: 0.001 })).toBe(true);
  });

  it("--promote never regresses (it rewrites the baseline)", () => {
    expect(isReplayRegression({ baseline: dropped }, { promote: true })).toBe(false);
  });

  it("hit-rate drop alone triggers it", () => {
    expect(isReplayRegression({ baseline: { deltaMeanRR: 0, deltaHitRate: -0.2 } })).toBe(true);
  });

  it("honors an env-configured eps", () => {
    process.env.EVAL_REPLAY_REGRESSION_EPS = "0.5";
    // -0.2 drop is now within tolerance
    expect(isReplayRegression({ baseline: dropped })).toBe(false);
  });
});

/**
 * Nine captured queries, all hitting at rank 1 when promoted. The second run
 * either drops every query to rank 2 (systematic) or misses one (noise).
 */
async function replayAfter(change: "systematic" | "one-flip" | "none") {
  const tmp = mkdtempSync(join(tmpdir(), "memex-replay-ci-"));
  const storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  try {
    for (let i = 0; i < 9; i++) {
      await recordQuery(storage.engine(), {
        id: `q${i}`,
        query: `query ${i}`,
        tag: "good",
        expectedDocId: `d${i}`,
      });
    }
    const docOf = (q: string) => `d${q.split(" ")[1]}`;
    await replayAll(storage, {
      searcher: async (q) => [{ documentId: docOf(q) }, { documentId: "x" }],
      promote: true,
    });
    return await replayAll(storage, {
      searcher: async (q) => {
        if (change === "systematic") return [{ documentId: "x" }, { documentId: docOf(q) }];
        if (change === "one-flip" && q === "query 0") return [{ documentId: "x" }];
        return [{ documentId: docOf(q) }, { documentId: "x" }];
      },
    });
  } finally {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  }
}

describe("replay bootstrap intervals", () => {
  it("carries intervals on the report", async () => {
    const r = await replayAfter("none");
    expect(r.meanRRCi95).toEqual({ lo: 1, hi: 1 });
    expect(r.hitRateCi95).toEqual({ lo: 1, hi: 1 });
    expect(r.baseline?.deltaMeanRRCi95).toEqual({ lo: 0, hi: 0 });
    expect(r.baseline?.significantDrop).toBe(false);
  });

  it("flags a systematic drop as beyond noise", async () => {
    const r = await replayAfter("systematic");
    expect(r.baseline?.deltaMeanRR).toBe(-0.5);
    expect(r.baseline?.deltaMeanRRCi95.hi).toBeLessThan(0);
    expect(r.baseline?.significantDrop).toBe(true);
    expect(isReplayRegression(r, { eps: 0.01 })).toBe(true);
    expect(regressionMessage(r.baseline!, 0.01)).toContain("beyond noise");
  });

  it("keeps one flipped query out of nine within noise, while the fixed-eps verdict still fires", async () => {
    const r = await replayAfter("one-flip");
    expect(r.baseline?.deltaMeanRR).toBeCloseTo(-1 / 9, 3);
    expect(r.baseline?.deltaMeanRRCi95.lo).toBeLessThan(0);
    expect(r.baseline?.deltaMeanRRCi95.hi).toBe(0);
    expect(r.baseline?.significantDrop).toBe(false);
    // The gate verdict is unchanged by the interval: -0.11 is past eps.
    expect(isReplayRegression(r, { eps: 0.01 })).toBe(true);
    expect(regressionMessage(r.baseline!, 0.01)).toContain("within noise");
  });
});
