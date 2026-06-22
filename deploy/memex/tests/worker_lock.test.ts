/**
 * Single-active-worker lock (migration 042 + core/jobs/worker-lock.ts) and its
 * wiring into the Worker. Offline (PGLite engine; no Bedrock).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import {
  acquireWorkerLock,
  heartbeatWorkerLock,
  releaseWorkerLock,
  readWorkerLock,
} from "../src/core/jobs/worker-lock.ts";
import { Worker } from "../src/core/jobs/worker.ts";
import { Queue } from "../src/core/jobs/queue.ts";

const LOCK = "test-worker";
let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-worker-lock-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("worker-lock helpers", () => {
  it("first holder acquires; a second live holder is refused", async () => {
    const e = storage.engine();
    expect(await acquireWorkerLock(e, LOCK, "A", 60)).toBe(true);
    expect(await acquireWorkerLock(e, LOCK, "B", 60)).toBe(false);
    const s = await readWorkerLock(e, LOCK);
    expect(s!.holder).toBe("A");
    expect(s!.stale).toBe(false);
  });

  it("the holder can re-acquire its own lock", async () => {
    const e = storage.engine();
    await acquireWorkerLock(e, LOCK, "A", 60);
    expect(await acquireWorkerLock(e, LOCK, "A", 60)).toBe(true);
  });

  it("heartbeat succeeds for the holder, fails for a non-holder", async () => {
    const e = storage.engine();
    await acquireWorkerLock(e, LOCK, "A", 60);
    expect(await heartbeatWorkerLock(e, LOCK, "A")).toBe(true);
    expect(await heartbeatWorkerLock(e, LOCK, "B")).toBe(false);
  });

  it("release frees the lock for another holder", async () => {
    const e = storage.engine();
    await acquireWorkerLock(e, LOCK, "A", 60);
    await releaseWorkerLock(e, LOCK, "A");
    expect(await readWorkerLock(e, LOCK)).toBeNull();
    expect(await acquireWorkerLock(e, LOCK, "B", 60)).toBe(true);
  });

  it("a stale heartbeat lets a survivor steal the lock", async () => {
    const e = storage.engine();
    await acquireWorkerLock(e, LOCK, "A", 60);
    // Backdate A's heartbeat well past the TTL.
    await e.query(
      `UPDATE worker_lock SET heartbeat_at = NOW() - INTERVAL '120 seconds' WHERE id = $1`,
      [LOCK],
    );
    const s = await readWorkerLock(e, LOCK);
    expect(s!.stale).toBe(true);
    expect(await acquireWorkerLock(e, LOCK, "B", 60)).toBe(true);
    expect((await readWorkerLock(e, LOCK))!.holder).toBe("B");
  });
});

describe("Worker single-active guard", () => {
  it("two workers sharing the lock elect exactly one holder", async () => {
    const e = storage.engine();
    const mk = () =>
      new Worker(new Queue(e), {
        intervalMs: 10,
        engine: e,
        workerLockId: LOCK,
        workerLockTtlSeconds: 60,
        logger: () => {},
      });
    const w1 = mk();
    const w2 = mk();
    w1.start();
    w2.start();
    // Let a few ticks run.
    await new Promise((r) => setTimeout(r, 200));
    const rows = await e.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM worker_lock WHERE id = $1`,
      [LOCK],
    );
    expect(rows.rows[0]!.n).toBe(1); // only one worker acquired
    await w1.stop();
    await w2.stop();
    // Both released / never held → row gone.
    expect(await readWorkerLock(e, LOCK)).toBeNull();
  });
});
