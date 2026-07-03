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
        baseline: { meanRR: 0.4, hitRate: 0.75, deltaMeanRR: 0.02, deltaHitRate: 0.05 },
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
});
