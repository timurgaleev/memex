/**
 * An aborted or timed-out phase stops at its next checkpoint instead of
 * writing on past the run, a phase whose lock was taken stops before its next
 * write, and a phase that reports failures it absorbed is never `ok`.
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
} from "../src/core/db-lock.ts";
import { deriveStatus, runCycleOnce, runPhase } from "../src/core/cycle/index.ts";
import { embedFactsPhase } from "../src/core/cycle/embed-facts.ts";
import {
  phaseCheckpoint,
  phaseFenceCheck,
  PhaseStoppedError,
  runInPhaseContext,
} from "../src/core/cycle/phase-context.ts";
import { NOOP_PROGRESS } from "../src/core/output/progress.ts";

const MIGRATIONS_DIR = join(import.meta.dir, "../src/core/migrations");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const VEC: number[] = Array.from<number>({ length: 1024 }).fill(0.01);

async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const orig = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = orig;
  }
}

async function stealLock(engine: Engine): Promise<void> {
  // A later tenure of the same pid on the same host: only acquired_at differs.
  await engine.query(`DELETE FROM cycle_locks WHERE id = $1`, [CYCLE_LOCK_ID]);
  await engine.query(
    `INSERT INTO cycle_locks (id, holder_pid, holder_host, acquired_at, ttl_expires_at, last_refreshed_at)
     VALUES ($1, $2, $3, NOW() + INTERVAL '1 minute', NOW() + INTERVAL '5 minutes', NOW())`,
    [CYCLE_LOCK_ID, process.pid, hostname()],
  );
}

describe("cycle phases stop when their run no longer owns them", () => {
  let tmp: string;
  let engine: PGliteEngine;
  let prevTimeout: string | undefined;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "cycle-fence-"));
    engine = new PGliteEngine({ dbPath: join(tmp, "db") });
    await engine.ready();
    await runMigrations(engine, MIGRATIONS_DIR);
    prevTimeout = process.env.MEMRAIN_CYCLE_PHASE_TIMEOUT_MS;
  });
  afterEach(async () => {
    if (prevTimeout === undefined) delete process.env.MEMRAIN_CYCLE_PHASE_TIMEOUT_MS;
    else process.env.MEMRAIN_CYCLE_PHASE_TIMEOUT_MS = prevTimeout;
    await engine.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  async function seedFacts(n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      await engine.query(
        `INSERT INTO entity_facts (entity_slug, fact, confidence) VALUES ($1, $2, 1)`,
        [`people/p${i}`, `fact number ${i}`],
      );
    }
  }
  async function embeddedCount(): Promise<number> {
    const r = await engine.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM entity_facts WHERE embedding IS NOT NULL`,
    );
    return Number(r.rows[0]!.n);
  }

  it("a timed-out phase stops writing at its next checkpoint", async () => {
    await seedFacts(30);
    process.env.MEMRAIN_CYCLE_PHASE_TIMEOUT_MS = "60";
    const embed = async () => {
      await sleep(15);
      return VEC;
    };
    const r = await quiet(() =>
      runPhase(engine, "embed-facts", () => embedFactsPhase(engine, { embed }), NOOP_PROGRESS, undefined, 0),
    );
    expect(r.status).toBe("fail");
    expect(r.error).toMatch(/timed out/);
    const atReturn = await embeddedCount();
    expect(atReturn).toBeLessThan(30);
    await sleep(400);
    // At most the item that was already past its checkpoint lands.
    expect((await embeddedCount()) - atReturn).toBeLessThanOrEqual(1);
  });

  it("an aborted phase stops writing at its next checkpoint", async () => {
    await seedFacts(30);
    const c = new AbortController();
    let calls = 0;
    const embed = async () => {
      if (++calls === 3) c.abort("lock_stolen");
      await sleep(10);
      return VEC;
    };
    const r = await quiet(() =>
      runPhase(engine, "embed-facts", () => embedFactsPhase(engine, { embed }), NOOP_PROGRESS, c.signal, 0),
    );
    expect(r.status).toBe("fail");
    await sleep(300);
    expect(await embeddedCount()).toBeLessThanOrEqual(3);
    expect(calls).toBeLessThanOrEqual(4);
  });

  it("a steal mid-phase stops the phase before its next write", async () => {
    await seedFacts(10);
    const lock = (await tryAcquireDbLock(engine, CYCLE_LOCK_ID, 5))!;
    let calls = 0;
    const embed = async () => {
      if (++calls === 3) await stealLock(engine);
      return VEC;
    };
    try {
      const r = await quiet(() =>
        runPhase(
          engine,
          "embed-facts",
          () => embedFactsPhase(engine, { embed }),
          NOOP_PROGRESS,
          undefined,
          1000,
          lock.isHeld,
        ),
      );
      expect(r.status).toBe("fail");
      expect(r.error).toContain("lock_stolen");
      // The embed that raced the steal never wrote: the fence sits before the UPDATE.
      expect(await embeddedCount()).toBe(2);
    } finally {
      await lock.release();
    }
  });

  it("runCycleOnce fences on the heartbeat's lock and reports lock_stolen", async () => {
    await engine.query(
      `INSERT INTO pages (slug, type, title, markdown_body, content_hash, source_id)
       VALUES ('notes/a', 'note', 'A', 'a', 'h', 'default')`,
    );
    await engine.query(`UPDATE pages SET salience = 0.5 WHERE slug = 'notes/a'`);
    const lock = (await tryAcquireDbLock(engine, CYCLE_LOCK_ID, 5))!;
    // A heartbeat that has not ticked yet: only the fence can see the steal.
    const hb = startLockHeartbeat(lock, { intervalMs: 60_000 });
    try {
      await stealLock(engine);
      const r = await quiet(() =>
        runCycleOnce(engine, { phases: ["recompute-salience", "snapshot"], signal: hb.signal }),
      );
      expect(r.outcome).toBe("partial");
      expect(r.reason).toBe("lock_stolen");
      expect(r.phases.map((p) => [p.phase, p.status])).toEqual([["recompute-salience", "fail"]]);
      expect(r.phasesNotRun).toEqual(["snapshot"]);
      const s = await engine.query<{ salience: number }>(`SELECT salience FROM pages WHERE slug = 'notes/a'`);
      expect(Number(s.rows[0]!.salience)).toBeCloseTo(0.5);
    } finally {
      hb.stop();
    }
  });

  it("isHeld tracks the tenure, not just the pid", async () => {
    const lock = (await tryAcquireDbLock(engine, CYCLE_LOCK_ID, 5))!;
    expect(await lock.isHeld()).toBe(true);
    await stealLock(engine);
    expect(await lock.isHeld()).toBe(false);
  });
});

describe("phase checkpoints outside a phase", () => {
  it("are no-ops", async () => {
    phaseCheckpoint();
    await phaseFenceCheck();
    expect(new PhaseStoppedError("x").message).toBe("phase stopped: x");
  });
});

describe("a fence query that throws", () => {
  it("stops the phase as fence_error instead of surfacing the raw error", async () => {
    const ctx = {
      signal: new AbortController().signal,
      fence: () => Promise.reject(new Error("connection reset")),
    };
    const err = await quiet(() =>
      runInPhaseContext(ctx, () => phaseFenceCheck().then(() => null, (e: unknown) => e)),
    );
    expect(err).toBeInstanceOf(PhaseStoppedError);
    expect((err as PhaseStoppedError).reason).toBe("fence_error");
  });
});

describe("runPhase never reports absorbed failures as ok", () => {
  it("a phase whose only misses are re-read guard refusals stays ok", async () => {
    const r = await quiet(() =>
      runPhase({} as Engine, "embed-stale", async () => ({ scanned: 3, reembedded: 1, rejected: 2, errors: [] }), NOOP_PROGRESS),
    );
    expect(r.status).toBe("ok");
    expect(
      deriveStatus("rechunk-sweep", {
        ran: true, scanned: 1, rechunked: 0, skippedMissing: 0, rejected: 1,
        charsProcessed: 0, budgetExhausted: false, errors: [],
      }),
    ).toBe("ok");
    expect(
      deriveStatus("rechunk-sweep", {
        ran: true, scanned: 1, rechunked: 0, skippedMissing: 0, rejected: 1,
        charsProcessed: 0, budgetExhausted: false, errors: [{ sourcePath: "/x.md", message: "read failed" }],
      }),
    ).toBe("warn");
  });

  it("lint conformance debt is informational, never warn", () => {
    expect(deriveStatus("lint", { scanned: 10, flagged: 9, summary: { "tags-missing": 9 } })).toBe("ok");
  });

  it("a warn tick logs the capped failing rows, not just the status", async () => {
    const errors = Array.from({ length: 8 }, (_, i) => ({
      sourcePath: `/memory/n${i}.md`,
      message: i === 0 ? `permission_denied ${"x".repeat(300)}` : `permission_denied ${i}`,
    }));
    const logged: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void logged.push(a.map(String).join(" "));
    let r;
    try {
      r = await runPhase({} as Engine, "embed-stale", async () => ({ scanned: 8, reembedded: 0, rejected: 0, errors }), NOOP_PROGRESS);
    } finally {
      console.error = orig;
    }
    expect(r.status).toBe("warn");
    const warn = logged.filter((l) => l.startsWith("[cycle] phase embed-stale warn:"));
    expect(warn[0]).toBe("[cycle] phase embed-stale warn: errors=8");
    const rows = warn.filter((l) => l.includes(" warn: error \""));
    expect(rows).toHaveLength(5);
    expect(rows[1]).toBe(`[cycle] phase embed-stale warn: error "/memory/n1.md": "permission_denied 1"`);
    expect(rows[0]!.length).toBeLessThan(260);
    expect(warn.at(-1)).toBe("[cycle] phase embed-stale warn: error ... and 3 more");
  });

  it("an ok phase logs no warn lines", async () => {
    const logged: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void logged.push(a.map(String).join(" "));
    try {
      await runPhase({} as Engine, "embed-stale", async () => ({ scanned: 1, reembedded: 1, rejected: 0, errors: [] }), NOOP_PROGRESS);
    } finally {
      console.error = orig;
    }
    expect(logged.some((l) => l.includes(" warn:"))).toBe(false);
  });

  it("a phase with no explicit rule that reports errors or failures is warn", () => {
    expect(deriveStatus("purge", { errors: ["x"] } as never)).toBe("warn");
    expect(deriveStatus("recompute-salience", { scanned: 1, updated: 0, failed: 1 } as never)).toBe("warn");
    expect(deriveStatus("recompute-salience", { scanned: 1, updated: 1 })).toBe("ok");
  });

  it("a phase that threw is fail", async () => {
    const r = await quiet(() =>
      runPhase({} as Engine, "purge", async () => {
        throw new Error("boom");
      }, NOOP_PROGRESS),
    );
    expect(r.status).toBe("fail");
    expect(r.ok).toBe(false);
    expect(r.error).toBe("boom");
  });
});
