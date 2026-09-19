/**
 * eval_snapshots (migration 068) — the nightly probe's durable history.
 * PGLite-backed; ReplayReport is hand-built (no live retrieval needed).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { recordEvalSnapshot, latestEvalSnapshot } from "../src/core/eval-snapshot.ts";
import type { ReplayReport } from "../src/core/eval-replay.ts";
import { evalTrendDetail } from "../src/commands/doctor.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-evalsnap-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

function report(overrides: Partial<ReplayReport> = {}): ReplayReport {
  return {
    ok: true,
    ranAt: new Date().toISOString(),
    totalQueries: 5,
    scored: 4,
    meanRR: 0.42,
    hitRate: 0.8,
    meanRRCi95: { lo: 0.21, hi: 0.63 },
    hitRateCi95: { lo: 0.5, hi: 1 },
    perQuery: [],
    ...overrides,
  };
}

describe("eval snapshots", () => {
  it("records a row and reads it back as the latest", async () => {
    const { id } = await recordEvalSnapshot(storage.engine(), report());
    expect(id).toBeGreaterThan(0);
    const latest = await latestEvalSnapshot(storage.engine());
    expect(latest?.scored).toBe(4);
    expect(latest?.mean_rr).toBeCloseTo(0.42, 5);
    expect(latest?.hit_rate).toBeCloseTo(0.8, 5);
  });

  it("keeps the baseline/stability blocks in detail", async () => {
    await recordEvalSnapshot(
      storage.engine(),
      report({
        baseline: {
          meanRR: 0.4,
          hitRate: 0.75,
          deltaMeanRR: 0.02,
          deltaHitRate: 0.05,
          deltaMeanRRCi95: { lo: -0.1, hi: 0.15 },
          deltaHitRateCi95: { lo: -0.25, hi: 0.25 },
          significantDrop: false,
        },
      }),
    );
    const latest = await latestEvalSnapshot(storage.engine());
    expect((latest?.detail as { baseline?: { deltaMeanRR: number } }).baseline?.deltaMeanRR).toBeCloseTo(0.02, 5);
  });

  it("returns the newest of several snapshots", async () => {
    await recordEvalSnapshot(storage.engine(), report({ ranAt: "2026-01-01T00:00:00Z", meanRR: 0.1 }));
    await recordEvalSnapshot(storage.engine(), report({ ranAt: "2026-06-01T00:00:00Z", meanRR: 0.9 }));
    const latest = await latestEvalSnapshot(storage.engine());
    expect(latest?.mean_rr).toBeCloseTo(0.9, 5);
  });

  it("records a zero-scored run (empty eval set)", async () => {
    await recordEvalSnapshot(
      storage.engine(),
      report({ totalQueries: 0, scored: 0, meanRR: 0, hitRate: 0 }),
    );
    const latest = await latestEvalSnapshot(storage.engine());
    expect(latest?.total_queries).toBe(0);
    expect(latest?.scored).toBe(0);
  });

  it("round-trips the bootstrap intervals through detail", async () => {
    await recordEvalSnapshot(storage.engine(), report());
    const latest = await latestEvalSnapshot(storage.engine());
    expect(latest?.detail["mean_rr_ci95"]).toEqual({ lo: 0.21, hi: 0.63 });
    expect(latest?.detail["hit_rate_ci95"]).toEqual({ lo: 0.5, hi: 1 });
  });
});

describe("doctor eval-trend detail", () => {
  const row = {
    ran_at: "2026-09-19 02:30:00+00",
    total_queries: 9,
    scored: 9,
    mean_rr: 0.611,
    hit_rate: 0.889,
  };

  it("appends the intervals from a snapshot that stored them", async () => {
    await recordEvalSnapshot(storage.engine(), report({ meanRR: 0.611, hitRate: 0.889 }));
    const latest = await latestEvalSnapshot(storage.engine());
    expect(evalTrendDetail(latest!)).toContain("mean_rr=0.611 [0.21–0.63] hit_rate=0.889 [0.50–1.00] (scored 4/5)");
  });

  it("renders a legacy row byte-identically to the pre-interval format", () => {
    expect(evalTrendDetail({ ...row, detail: { ok: true } })).toBe(
      "last probe 2026-09-19 02:30:00+00: mean_rr=0.611 hit_rate=0.889 (scored 9/9)",
    );
  });

  it("still reports an empty eval set as unmeasured", () => {
    expect(evalTrendDetail({ ...row, total_queries: 0, scored: 0, detail: {} })).toContain("EMPTY");
  });
});
