/**
 * Cycle abort plumbing: the lock heartbeat turns a lost lock into an abort
 * signal, and runCycleOnce / runPhase stop on it with a versioned report.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { PGliteEngine } from "../src/core/engine/pglite.ts";
import type { Engine } from "../src/core/engine/interface.ts";
import { runMigrations } from "../src/core/migrate.ts";
import {
  CYCLE_LOCK_ID,
  startLockHeartbeat,
  tryAcquireDbLock,
  type DbLockHandle,
} from "../src/core/db-lock.ts";
import {
  CYCLE_REPORT_SCHEMA_VERSION,
  runCycleOnce,
  runPhase,
  skippedCycleResult,
} from "../src/core/cycle/index.ts";
import { assertBedrockOpen } from "../src/core/llm/bedrock-errors.ts";
import { NOOP_PROGRESS } from "../src/core/output/progress.ts";

const MIGRATIONS_DIR = join(import.meta.dir, "../src/core/migrations");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function abortedWith(reason: string): AbortSignal {
  const c = new AbortController();
  c.abort(reason);
  return c.signal;
}

describe("cycle abort — with a PGLite brain", () => {
  let tmp: string;
  let engine: PGliteEngine;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "cycle-abort-"));
    engine = new PGliteEngine({ dbPath: join(tmp, "db") });
    await engine.ready();
    await runMigrations(engine, MIGRATIONS_DIR);
  });
  afterEach(async () => {
    await engine.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("startLockHeartbeat aborts with lock_stolen within 3 intervals of a steal", async () => {
    const lock = (await tryAcquireDbLock(engine, CYCLE_LOCK_ID, 5))!;
    let lost = 0;
    const hb = startLockHeartbeat(lock, { intervalMs: 20, onLost: () => lost++ });
    try {
      await sleep(50);
      expect(hb.signal.aborted).toBe(false); // still ours: refreshes succeed

      await engine.query(`DELETE FROM cycle_locks WHERE id = $1`, [CYCLE_LOCK_ID]);
      await engine.query(
        `INSERT INTO cycle_locks (id, holder_pid, holder_host, acquired_at, ttl_expires_at, last_refreshed_at)
         VALUES ($1, $2, $3, NOW() + INTERVAL '1 minute', NOW() + INTERVAL '5 minutes', NOW())`,
        [CYCLE_LOCK_ID, process.pid, hostname()],
      );
      const stolenAt = Date.now();
      while (!hb.signal.aborted && Date.now() - stolenAt < 1000) await sleep(5);
      expect(hb.signal.aborted).toBe(true);
      expect(Date.now() - stolenAt).toBeLessThan(3 * 20 + 40);
      expect(hb.signal.reason).toBe("lock_stolen");
      expect(lost).toBe(1);
    } finally {
      hb.stop();
    }
  });

  it("a pre-aborted run returns partial/lock_stolen and runs no phase", async () => {
    const r = await runCycleOnce(engine, {
      phases: ["lint", "snapshot"],
      signal: abortedWith("lock_stolen"),
    });
    expect(r.schemaVersion).toBe(2);
    expect(r.outcome).toBe("partial");
    expect(r.reason).toBe("lock_stolen");
    expect(r.phases).toEqual([]);
    expect(r.phasesNotRun).toEqual(["lint", "snapshot"]);
    expect(r.ok).toBe(false);
    expect(r.status).toBe("fail");
  });

  it("an abort reason outside the known set reports `aborted`", async () => {
    const c = new AbortController();
    c.abort();
    const r = await runCycleOnce(engine, { phases: ["lint"], signal: c.signal });
    expect(r.outcome).toBe("partial");
    expect(r.reason).toBe("aborted");
  });

  it("a normal run is complete, with no reason", async () => {
    const r = await runCycleOnce(engine, {
      phases: ["lint", "snapshot"],
      signal: new AbortController().signal,
    });
    expect(r.schemaVersion).toBe(CYCLE_REPORT_SCHEMA_VERSION);
    expect(r.outcome).toBe("complete");
    expect(r.reason).toBeUndefined();
    expect(r.phasesNotRun).toBeUndefined();
    expect(r.phases.map((p) => p.phase)).toEqual(["lint", "snapshot"]);
  });
});

describe("startLockHeartbeat — transient refresh errors", () => {
  it("does not abort when refresh throws", async () => {
    let calls = 0;
    const lock: DbLockHandle = {
      id: CYCLE_LOCK_ID,
      release: async () => {},
      refresh: async () => {
        calls++;
        throw new Error("connection reset");
      },
    };
    const origError = console.error;
    console.error = () => {};
    const hb = startLockHeartbeat(lock, { intervalMs: 20 });
    try {
      await sleep(90);
      expect(calls).toBeGreaterThanOrEqual(2);
      expect(hb.signal.aborted).toBe(false);
    } finally {
      hb.stop();
      console.error = origError;
    }
  });
});

describe("runPhase — abort during a phase", () => {
  it("fails the phase at once with the reason and stops its paid calls", async () => {
    let probe: "open" | "halted" | undefined;
    // Never settles; a timer inside the phase's batch scope checks whether a
    // Bedrock call would still be allowed after the abort.
    const hang = () =>
      new Promise<never>(() => {
        setTimeout(() => {
          try {
            assertBedrockOpen("any-model");
            probe = "open";
          } catch {
            probe = "halted";
          }
        }, 40);
      });
    const c = new AbortController();
    setTimeout(() => c.abort("lock_stolen"), 10);
    const start = Date.now();
    const r = await runPhase({} as Engine, "extract", hang, NOOP_PROGRESS, c.signal);
    expect(Date.now() - start).toBeLessThan(1000);
    expect(r.status).toBe("fail");
    expect(r.ok).toBe(false);
    expect(r.error).toBe("aborted: lock_stolen");
    await sleep(60);
    expect(probe).toBe("halted");
  });
});

describe("skippedCycleResult", () => {
  it("describes a run that never started", () => {
    const r = skippedCycleResult("cycle_already_running", ["lint"]);
    expect(r.schemaVersion).toBe(2);
    expect(r.outcome).toBe("skipped");
    expect(r.reason).toBe("cycle_already_running");
    expect(r.phases).toEqual([]);
    expect(r.phasesNotRun).toEqual(["lint"]);
    expect(r.ok).toBe(true);
  });
});
