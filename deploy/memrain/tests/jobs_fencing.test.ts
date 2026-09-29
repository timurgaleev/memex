/**
 * Attempt fencing (migration 109): every claim bumps `claim_generation`, and
 * every write an attempt makes presents the generation it claimed. An attempt
 * that stalled or timed out, and whose row a newer attempt has re-claimed,
 * must not be able to finish, fail, or write progress onto that newer attempt.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { Queue } from "../src/core/jobs/queue.ts";
import { Worker } from "../src/core/jobs/worker.ts";
import {
  _resetHandlersForTesting,
  registerHandler,
} from "../src/core/jobs/handlers.ts";
import { getJob } from "../src/core/jobs/dag.ts";

let tmp: string;
let storage: Storage;
let queue: Queue;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-jobfence-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  queue = new Queue(storage.engine());
  _resetHandlersForTesting();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

/** Claim, let the lock lapse, requeue via the stall sweep, and re-claim. */
async function stallAndReclaim(id: string): Promise<Date> {
  const later = new Date(Date.now() + 10 * 60_000);
  const swept = await queue.handleStalled({ now: later });
  expect(swept.ids).toContain(id);
  const second = await queue.claim({ now: later });
  expect(second?.id).toBe(id);
  expect(second?.claimGeneration).toBe(2);
  return later;
}

describe("claim generation", () => {
  it("starts at 0 and every claim bumps it", async () => {
    const j = await queue.enqueue({ kind: "x", id: "g" });
    expect(j.claimGeneration).toBe(0);
    const first = await queue.claim();
    expect(first?.claimGeneration).toBe(1);
    await stallAndReclaim("g");
    expect((await getJob(storage.engine(), "g"))?.claim_generation).toBe(2);
  });
});

describe("stale attempt writes are refused", () => {
  it("complete with a stale generation is a no-op; the current one succeeds", async () => {
    await queue.enqueue({ kind: "x", id: "c" });
    await queue.claim();
    await stallAndReclaim("c");

    expect(await queue.complete("c", 1, { from: "stale" })).toBeNull();
    const mid = await queue.get("c");
    expect(mid?.status).toBe("running");
    expect(mid?.claimGeneration).toBe(2);
    expect(mid?.result).toBeNull();

    const done = await queue.complete("c", 2, { from: "current" });
    expect(done?.status).toBe("succeeded");
    expect(done?.result).toEqual({ from: "current" });
  });

  it("fail with a stale generation spends no retry and reschedules nothing", async () => {
    await queue.enqueue({ kind: "x", id: "f", maxRetries: 3 });
    await queue.claim();
    await stallAndReclaim("f");
    const before = await queue.get("f");

    expect(await queue.fail("f", 1, "stale boom")).toBeNull();
    expect(await queue.fail("f", 1, "stale dead", { terminal: true })).toBeNull();
    const after = await queue.get("f");
    expect(after?.status).toBe("running");
    expect(after?.retryCount).toBe(before!.retryCount);
    expect(after?.nextAttemptAt.getTime()).toBe(before!.nextAttemptAt.getTime());
    expect(after?.lastError).toBe(before!.lastError);
  });

  it("progress, usage and lock extension with a stale generation change nothing", async () => {
    await queue.enqueue({ kind: "x", id: "p" });
    await queue.claim();
    await stallAndReclaim("p");
    expect(await queue.updateProgress("p", 2, { step: 1 })).toBe(true);
    const before = await queue.get("p");

    expect(await queue.updateProgress("p", 1, { step: 99 })).toBe(false);
    expect(await queue.recordUsage("p", 1, { tokensInput: 500, costUsd: 1 })).toBe(false);
    expect(
      await queue.extendLock("p", 1, new Date(Date.now() + 3_600_000)),
    ).toBe(false);

    const after = await queue.get("p");
    expect(after?.progress).toEqual({ step: 1 });
    expect(after?.tokensInput).toBe(0);
    expect(after?.costUsd).toBe(0);
    expect(after?.lockUntil?.getTime()).toBe(before!.lockUntil!.getTime());
  });

  it("operator cancel stays ungated and still stops a re-claimed row", async () => {
    await queue.enqueue({ kind: "x", id: "k" });
    await queue.claim();
    await stallAndReclaim("k");
    const cancelled = await queue.cancel("k");
    expect(cancelled?.status).toBe("cancelled");
    expect(await queue.complete("k", 2, {})).toBeNull();
  });
});

describe("worker end to end", () => {
  it("a stalled attempt's late result is discarded and counted as fenced", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let started!: () => void;
    const running = new Promise<void>((r) => {
      started = r;
    });
    const staleWrites: boolean[] = [];
    registerHandler("slow", async (_payload, ctx) => {
      started();
      await gate;
      staleWrites.push((await ctx.updateProgress?.({ from: "stale" })) ?? true);
      staleWrites.push((await ctx.recordUsage?.({ tokensInput: 9 })) ?? true);
      return { from: "stale" };
    });
    const logs: string[] = [];
    const worker = new Worker(queue, { logger: (_l, m) => logs.push(m) });
    await queue.enqueue({ kind: "slow", id: "w" });

    const drained = worker.drainOnce();
    await running;
    // While the first attempt is blocked, its lock lapses and a newer attempt
    // takes the row.
    await stallAndReclaim("w");
    release();
    await drained;

    expect(staleWrites).toEqual([false, false]);
    const stats = worker.getStats();
    expect(stats.fenced).toBe(1);
    expect(stats.succeeded).toBe(0);
    expect(logs.some((m) => m.includes("claim lost to a newer attempt (gen 1)"))).toBe(true);

    const mid = await queue.get("w");
    expect(mid?.status).toBe("running");
    expect(mid?.claimGeneration).toBe(2);
    expect(mid?.progress).toBeNull();
    expect(mid?.tokensInput).toBe(0);

    // The second attempt owns the outcome.
    const done = await queue.complete("w", 2, { from: "current" });
    expect(done?.result).toEqual({ from: "current" });
  });

  it("a normal run is not counted as fenced", async () => {
    registerHandler("quick", async () => ({ ok: true }));
    await queue.enqueue({ kind: "quick", id: "n" });
    const worker = new Worker(queue);
    await worker.drainOnce();
    expect(worker.getStats()).toMatchObject({ succeeded: 1, fenced: 0 });
    expect((await queue.get("n"))?.claimGeneration).toBe(1);
  });
});
