/**
 * Cycle abort plumbing: the lock heartbeat turns a lost lock into an abort
 * signal, and runCycleOnce / runPhase stop on it with a versioned report.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  runInAbortableBatchScope,
  runPhase,
  skippedCycleResult,
} from "../src/core/cycle/index.ts";
import { runDeepSynthUnderLock } from "../src/recipes/cycle.ts";
import type { Storage } from "../src/core/storage.ts";
import type { DeepSynthResult } from "../src/core/synthesis/deep-synth.ts";
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

  // runPhase logs "phase <name> done" after the phase's work settled and
  // before it returns, which is the one hook between two phases.
  async function runAbortingAfter(phaseDone: string, reason: string) {
    const c = new AbortController();
    const origError = console.error;
    const origRss = process.env.MEMEX_CYCLE_RSS_LOG;
    delete process.env.MEMEX_CYCLE_RSS_LOG;
    console.error = (...args: unknown[]) => {
      if (String(args[0]).includes(`phase ${phaseDone} done`)) c.abort(reason);
    };
    try {
      return await runCycleOnce(engine, { phases: ["lint", "snapshot"], signal: c.signal });
    } finally {
      console.error = origError;
      if (origRss === undefined) delete process.env.MEMEX_CYCLE_RSS_LOG;
      else process.env.MEMEX_CYCLE_RSS_LOG = origRss;
    }
  }

  it("an abort between phases runs no further phase and reports partial", async () => {
    const r = await runAbortingAfter("lint", "lock_stolen");
    expect(r.outcome).toBe("partial");
    expect(r.reason).toBe("lock_stolen");
    expect(r.phases.map((p) => [p.phase, p.ok])).toEqual([["lint", true]]);
    expect(r.phasesNotRun).toEqual(["snapshot"]);
    expect(r.ok).toBe(false);
  });

  it("an abort after the last phase finished leaves the run complete", async () => {
    const r = await runAbortingAfter("snapshot", "lock_stolen");
    expect(r.outcome).toBe("complete");
    expect(r.reason).toBeUndefined();
    expect(r.phasesNotRun).toBeUndefined();
    expect(r.phases.map((p) => p.phase)).toEqual(["lint", "snapshot"]);
  });
});

describe("cycle callers wire the lock heartbeat into the run", () => {
  const src = (rel: string) => readFileSync(join(import.meta.dir, "../src", rel), "utf8");

  it("the daemon tick passes heartbeat.signal to runCycleOnce", () => {
    expect(src("recipes/cycle.ts")).toMatch(
      /runCycleOnce\(storage\.engine\(\), \{[^}]*signal: heartbeat\.signal[^}]*\}\)/,
    );
  });

  it("the one-shot command passes heartbeat.signal to runCycleOnce", () => {
    const text = src("commands/cycle.ts");
    expect(text).toMatch(/const cycleOpts: CycleOptions = \{[^}]*signal: heartbeat\.signal[^}]*\}/);
    expect(text).toContain("runCycleOnce(storage.engine(), cycleOpts)");
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
    let haltMessage = "";
    // Never settles; a timer inside the phase's batch scope checks whether a
    // Bedrock call would still be allowed after the abort.
    const hang = () =>
      new Promise<never>(() => {
        setTimeout(() => {
          try {
            assertBedrockOpen("any-model");
            probe = "open";
          } catch (e) {
            probe = "halted";
            haltMessage = (e as Error).message;
          }
        }, 40);
      });
    const c = new AbortController();
    setTimeout(() => c.abort("lock_stolen"), 10);
    const start = Date.now();
    const origError = console.error;
    console.error = () => {};
    let r;
    try {
      r = await runPhase({} as Engine, "extract", hang, NOOP_PROGRESS, c.signal, 20);
    } finally {
      console.error = origError;
    }
    expect(Date.now() - start).toBeLessThan(1000);
    expect(r.status).toBe("fail");
    expect(r.ok).toBe(false);
    expect(r.error).toBe("aborted: lock_stolen");
    // It never wound down inside the settle window, so the report says so.
    expect(r.orphaned).toBe(true);
    await sleep(60);
    expect(probe).toBe("halted");
    expect(haltMessage).toContain("stopped: lock_stolen");
    expect(haltMessage).not.toContain("timed out");
  });

  it("waits for an aborted phase that winds down inside the settle window", async () => {
    let finished = false;
    const slowToStop = () =>
      new Promise<{ errors: string[] }>((resolve) => {
        setTimeout(() => {
          finished = true;
          resolve({ errors: [] });
        }, 50);
      });
    const c = new AbortController();
    setTimeout(() => c.abort("lock_stolen"), 10);
    const r = await runPhase({} as Engine, "extract", slowToStop, NOOP_PROGRESS, c.signal, 2000);
    // The run did not return while the phase's own work was still in flight.
    expect(finished).toBe(true);
    expect(r.status).toBe("fail");
    expect(r.error).toBe("aborted: lock_stolen");
    expect(r.orphaned).toBeUndefined();
  });
});

describe("deep-synth under the cycle lock", () => {
  const blankResult = (questionsAsked: number): DeepSynthResult => ({
    ran: true,
    questionsAsked,
    syntheses: [],
    spentUsd: 0,
    budgetExhausted: false,
  });

  it("an abort mid-pass stops further Bedrock calls and reaches the pass", async () => {
    const c = new AbortController();
    const probes: string[] = [];
    let seenSignal: AbortSignal | undefined;
    const probe = () => {
      try {
        assertBedrockOpen("any-model");
        probes.push("open");
      } catch {
        probes.push("halted");
      }
    };
    const fakeRun = async (_s: Storage, opts: { signal?: AbortSignal } = {}) => {
      seenSignal = opts.signal;
      probe(); // before the steal: calls go out
      c.abort("lock_stolen");
      await sleep(5);
      probe(); // after: the heartbeat's abort halts them
      return blankResult(1);
    };
    await runDeepSynthUnderLock({} as Storage, c.signal, fakeRun as never);
    expect(probes).toEqual(["open", "halted"]);
    expect(seenSignal).toBe(c.signal);
  });

  it("a scope entered after the lock was lost is already stopped", async () => {
    let probe: string | undefined;
    await runInAbortableBatchScope(abortedWith("lock_stolen"), async () => {
      try {
        assertBedrockOpen("any-model");
        probe = "open";
      } catch (e) {
        probe = (e as Error).message;
      }
    });
    expect(probe).toBe("BedrockHalted: the batch run this call belongs to was stopped: lock_stolen");
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
