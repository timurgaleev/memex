/**
 * eval-replay CI regression gate — the pure predicate + eps resolver.
 * Hermetic: no DB, no Bedrock; exercises isReplayRegression / evalRegressionEps.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
  isReplayRegression,
  evalRegressionEps,
  DEFAULT_EVAL_REGRESSION_EPS,
} from "../src/commands/eval-replay.ts";

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
