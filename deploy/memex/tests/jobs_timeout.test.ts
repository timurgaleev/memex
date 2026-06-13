/**
 * Per-job hard wall-clock timeout (migration 039): the worker races a handler
 * against `timeoutMs` and DEAD-LETTERS (terminal fail, no retry) one that
 * exceeds it, freeing the single-worker slot a wedged handler would otherwise
 * hold forever.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { Queue } from "../src/core/jobs/queue.ts";
import { Worker } from "../src/core/jobs/worker.ts";
import {
  registerHandler,
  _resetHandlersForTesting,
} from "../src/core/jobs/handlers.ts";
import { submitJob } from "../src/core/jobs/dag.ts";

let tmp: string;
let storage: Storage;
let queue: Queue;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-jobtimeout-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  queue = new Queue(storage.engine());
  _resetHandlersForTesting();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

const wedge = () => new Promise<Record<string, unknown>>(() => {}); // never resolves

describe("enqueue timeoutMs", () => {
  it("persists a positive timeoutMs and round-trips it", async () => {
    const j = await queue.enqueue({ kind: "x", id: "tm", timeoutMs: 1234 });
    expect(j.timeoutMs).toBe(1234);
    expect((await queue.get("tm"))?.timeoutMs).toBe(1234);
  });
  it("defaults timeoutMs to null when omitted", async () => {
    const j = await queue.enqueue({ kind: "x", id: "tn" });
    expect(j.timeoutMs).toBeNull();
  });
  it("rejects a non-positive or out-of-range timeoutMs", async () => {
    await expect(
      queue.enqueue({ kind: "x", timeoutMs: 0 }),
    ).rejects.toThrow(/positive/);
    await expect(
      queue.enqueue({ kind: "x", timeoutMs: -5 }),
    ).rejects.toThrow(/positive/);
    // Above the Postgres INTEGER ceiling -> rejected before INSERT.
    await expect(
      queue.enqueue({ kind: "x", timeoutMs: 2_147_483_648 }),
    ).rejects.toThrow(/2147483647/);
  });
});

describe("submitJob timeout_ms (durable / MCP path)", () => {
  it("persists a positive timeout_ms", async () => {
    const r = await submitJob(storage.engine(), { kind: "x", timeout_ms: 4321 });
    expect((await queue.get(r.id))?.timeoutMs).toBe(4321);
  });
  it("defaults to null when omitted", async () => {
    const r = await submitJob(storage.engine(), { kind: "x" });
    expect((await queue.get(r.id))?.timeoutMs).toBeNull();
  });
  it("rejects a non-positive or out-of-range timeout_ms", async () => {
    await expect(
      submitJob(storage.engine(), { kind: "x", timeout_ms: 0 }),
    ).rejects.toThrow(/positive/);
    await expect(
      submitJob(storage.engine(), { kind: "x", timeout_ms: 2_147_483_648 }),
    ).rejects.toThrow(/2147483647/);
  });
});

describe("queue.fail terminal", () => {
  it("forces a terminal failed even with retries remaining", async () => {
    await queue.enqueue({ kind: "x", id: "t1", maxRetries: 5 });
    const claimed = await queue.claim();
    const r = await queue.fail(claimed!.id, "boom", { terminal: true });
    expect(r?.status).toBe("failed");
    expect(r?.lockUntil).toBeNull();
  });
});

describe("extendLock (timeout outlasting the claim lock)", () => {
  it("keeps the stall sweep from requeuing a running job", async () => {
    await queue.enqueue({ kind: "x", id: "ex" });
    const claimed = await queue.claim({ lockSeconds: 1 }); // lock = now + 1s
    expect(claimed!.id).toBe("ex");
    // The worker extends the lock to cover a long timeout. A sweep 2s later
    // (past the original 1s lock) must NOT requeue it.
    expect(await queue.extendLock("ex", new Date(Date.now() + 10_000))).toBe(
      true,
    );
    const r = await queue.handleStalled({ now: new Date(Date.now() + 2000) });
    expect(r.requeued).toBe(0);
    expect((await queue.get("ex"))?.status).toBe("running");
  });

  it("returns false and is a no-op on a job that is no longer running", async () => {
    await queue.enqueue({ kind: "x", id: "ex2" });
    // ex2 is still pending (never claimed) -> extendLock must not touch it.
    expect(await queue.extendLock("ex2", new Date(Date.now() + 10_000))).toBe(
      false,
    );
    expect((await queue.get("ex2"))?.lockUntil).toBeNull();
  });
});

describe("worker per-job timeout", () => {
  it("dead-letters a wedged handler and frees the worker for the next job", async () => {
    registerHandler("wedge", wedge);
    registerHandler("ok", async () => ({ done: true }));
    await queue.enqueue({ kind: "wedge", id: "w1", timeoutMs: 50, maxRetries: 3 });
    await queue.enqueue({ kind: "ok", id: "o1" });

    const worker = new Worker(queue);
    await worker.drainOnce();

    const w = await queue.get("w1");
    expect(w?.status).toBe("failed"); // dead-lettered despite maxRetries: 3
    expect(w?.lastError).toMatch(/timeout/);
    const o = await queue.get("o1");
    expect(o?.status).toBe("succeeded"); // worker was not stuck on the wedge
    expect(worker.getStats().timedOut).toBe(1);
  });

  it("applies the worker default jobTimeoutMs when the job sets none", async () => {
    registerHandler("wedge", wedge);
    await queue.enqueue({ kind: "wedge", id: "wd" }); // no per-job timeout
    const worker = new Worker(queue, { jobTimeoutMs: 50 });
    await worker.drainOnce();
    expect((await queue.get("wd"))?.status).toBe("failed");
    expect(worker.getStats().timedOut).toBe(1);
  });

  it("does not time out a fast handler under a generous default", async () => {
    registerHandler("fast", async () => ({ ok: 1 }));
    await queue.enqueue({ kind: "fast", id: "f1" });
    const worker = new Worker(queue, { jobTimeoutMs: 5000 });
    await worker.drainOnce();
    expect((await queue.get("f1"))?.status).toBe("succeeded");
    expect(worker.getStats().timedOut).toBe(0);
  });

  it("runs handlers unchanged when no timeout is configured", async () => {
    registerHandler("plain", async () => ({ ok: 1 }));
    await queue.enqueue({ kind: "plain", id: "p1" });
    const worker = new Worker(queue); // no default, no per-job
    await worker.drainOnce();
    expect((await queue.get("p1"))?.status).toBe("succeeded");
    expect(worker.getStats().timedOut).toBe(0);
  });

  it("routes a handler that throws synchronously through fail (not a crash)", async () => {
    // Under the timeout path runWithTimeout calls start(); a synchronous throw
    // must become a normal rejection, not an unhandled error or a timeout.
    registerHandler("syncthrow", (() => {
      throw new Error("sync boom");
    }) as never);
    await queue.enqueue({
      kind: "syncthrow",
      id: "st",
      maxRetries: 0,
      timeoutMs: 1000,
    });
    const worker = new Worker(queue);
    await worker.drainOnce();
    const j = await queue.get("st");
    expect(j?.status).toBe("failed");
    expect(j?.lastError).toMatch(/sync boom/);
    expect(worker.getStats().timedOut).toBe(0);
  });
});
