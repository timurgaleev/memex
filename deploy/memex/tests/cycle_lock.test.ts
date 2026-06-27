/**
 * Migration 050 + db-lock — cross-process cycle lock.
 *
 * Verifies the row-based lock primitive on a fresh PGLite:
 *   - acquire on a free lock succeeds (returns a handle);
 *   - while held, a competing acquire (simulated by a second live holder row)
 *     returns null — the ON CONFLICT steal is gated on ttl_expires_at < NOW();
 *   - after release the row is gone and the next acquire succeeds again.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostname } from "node:os";
import { PGliteEngine } from "../src/core/engine/pglite.ts";
import { runMigrations } from "../src/core/migrate.ts";
import {
  CYCLE_LOCK_ID,
  tryAcquireDbLock,
  classifyHolderLiveness,
  isHolderDeadLocally,
  inspectLock,
  listStaleLocks,
  deleteLockRow,
  deleteLockRowExact,
  deleteLockRowIfStale,
  reapDeadHolderLocks,
} from "../src/core/db-lock.ts";

const MIGRATIONS_DIR = join(import.meta.dir, "../src/core/migrations");

/** A liveness probe that reports a given PID dead (ESRCH) and all others alive. */
function killSeam(deadPid: number) {
  return (pid: number, _sig: number) => {
    if (pid === deadPid) {
      const e = new Error("no such process") as NodeJS.ErrnoException;
      e.code = "ESRCH";
      throw e;
    }
  };
}

async function insertHolder(
  engine: PGliteEngine,
  opts: { id?: string; pid: number; host: string; ageMin?: number; ttlMin?: number; refreshedMin?: number },
): Promise<void> {
  const { id = CYCLE_LOCK_ID, pid, host, ageMin = 0, ttlMin = 30, refreshedMin = 0 } = opts;
  await engine.query(
    `INSERT INTO cycle_locks (id, holder_pid, holder_host, acquired_at, ttl_expires_at, last_refreshed_at)
     VALUES ($1, $2, $3, NOW() - ($4 || ' minutes')::interval, NOW() + ($5 || ' minutes')::interval, NOW() - ($6 || ' minutes')::interval)`,
    [id, pid, host, String(ageMin), String(ttlMin), String(refreshedMin)],
  );
}

describe("cycle lock — db-lock + migration 050", () => {
  let tmp: string;
  let engine: PGliteEngine;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "cyclock050-"));
    engine = new PGliteEngine({ dbPath: join(tmp, "db") });
    await engine.ready();
    await runMigrations(engine, MIGRATIONS_DIR);
  });

  afterEach(async () => {
    await engine.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("acquires a free lock and writes the holder row", async () => {
    const handle = await tryAcquireDbLock(engine, CYCLE_LOCK_ID, 30);
    expect(handle).not.toBeNull();
    expect(handle?.id).toBe(CYCLE_LOCK_ID);

    const r = await engine.query<{ id: string }>(
      "SELECT id FROM cycle_locks WHERE id = $1",
      [CYCLE_LOCK_ID],
    );
    expect(r.rows[0]?.id).toBe(CYCLE_LOCK_ID);
  });

  it("returns null while a live holder owns the lock", async () => {
    // Simulate a different live holder: a non-expired row owned by another pid.
    await engine.query(
      `INSERT INTO cycle_locks (id, holder_pid, holder_host, acquired_at, ttl_expires_at, last_refreshed_at)
       VALUES ($1, $2, $3, NOW(), NOW() + INTERVAL '30 minutes', NOW())`,
      [CYCLE_LOCK_ID, process.pid + 1, "other-host"],
    );

    const handle = await tryAcquireDbLock(engine, CYCLE_LOCK_ID, 30);
    expect(handle).toBeNull();
  });

  it("lets the next acquire succeed after release", async () => {
    const first = await tryAcquireDbLock(engine, CYCLE_LOCK_ID, 30);
    expect(first).not.toBeNull();
    await first!.release();

    const gone = await engine.query<{ id: string }>(
      "SELECT id FROM cycle_locks WHERE id = $1",
      [CYCLE_LOCK_ID],
    );
    expect(gone.rows.length).toBe(0);

    const second = await tryAcquireDbLock(engine, CYCLE_LOCK_ID, 30);
    expect(second).not.toBeNull();
  });

  it("auto-takes-over a provably-dead same-host holder whose TTL has NOT expired", async () => {
    // A short-lived child, already exited → its PID is provably dead (ESRCH) on
    // this host. acquired_at past the 60s grace, TTL still in the future so the
    // upsert's WHERE ttl_expires_at < NOW() can't reclaim it — only the active
    // auto-takeover can.
    const child = Bun.spawnSync(["sh", "-c", "exit 0"]);
    const deadPid = child.pid;
    await insertHolder(engine, { pid: deadPid, host: hostname(), ageMin: 5, ttlMin: 30 });

    const handle = await tryAcquireDbLock(engine, CYCLE_LOCK_ID, 30);
    expect(handle).not.toBeNull();
    const r = await engine.query<{ holder_pid: number }>(
      "SELECT holder_pid FROM cycle_locks WHERE id = $1",
      [CYCLE_LOCK_ID],
    );
    expect(Number(r.rows[0]?.holder_pid)).toBe(process.pid); // reclaimed by us
  });
});

describe("classifyHolderLiveness", () => {
  const HOST = "h1";
  it("classifies cross-host / alive / EPERM / young-dead / old-dead / unknown", () => {
    const base = { localHost: HOST };
    // cross-host: never probed
    expect(classifyHolderLiveness(1, "other", 999_999, base)).toBe("cross_host");
    // alive (probe succeeds)
    expect(classifyHolderLiveness(1, HOST, 999_999, { ...base, processKill: () => {} })).toBe("alive");
    // EPERM → alive (exists, not ours)
    expect(
      classifyHolderLiveness(1, HOST, 999_999, {
        ...base,
        processKill: () => { const e = new Error("eperm") as NodeJS.ErrnoException; e.code = "EPERM"; throw e; },
      }),
    ).toBe("alive");
    // ESRCH but younger than grace → too_young
    expect(classifyHolderLiveness(1, HOST, 1_000, { ...base, processKill: killSeam(1) })).toBe("too_young");
    // ESRCH and past grace → dead_eligible
    expect(classifyHolderLiveness(1, HOST, 999_999, { ...base, processKill: killSeam(1) })).toBe("dead_eligible");
    expect(isHolderDeadLocally(1, HOST, 999_999, { ...base, processKill: killSeam(1) })).toBe(true);
    // other error → unknown
    expect(
      classifyHolderLiveness(1, HOST, 999_999, {
        ...base,
        processKill: () => { const e = new Error("eio") as NodeJS.ErrnoException; e.code = "EIO"; throw e; },
      }),
    ).toBe("unknown");
  });
});

describe("inspect / list / delete / reap", () => {
  let tmp2: string;
  let engine: PGliteEngine;

  beforeEach(async () => {
    tmp2 = mkdtempSync(join(tmpdir(), "cyclock-ops-"));
    engine = new PGliteEngine({ dbPath: join(tmp2, "db") });
    await engine.ready();
    await runMigrations(engine, MIGRATIONS_DIR);
  });
  afterEach(async () => {
    await engine.close();
    rmSync(tmp2, { recursive: true, force: true });
  });

  it("inspectLock returns a snapshot with derived fields; null when absent", async () => {
    expect(await inspectLock(engine, CYCLE_LOCK_ID)).toBeNull();
    await insertHolder(engine, { pid: 4242, host: "h", ageMin: 1, ttlMin: 30, refreshedMin: 1 });
    const snap = await inspectLock(engine, CYCLE_LOCK_ID);
    expect(snap?.holder_pid).toBe(4242);
    expect(snap?.ttl_expired).toBe(false);
    expect(snap?.ms_since_last_refresh).toBeGreaterThan(0);
  });

  it("listStaleLocks returns only TTL-expired rows", async () => {
    await insertHolder(engine, { id: "memex-cycle", pid: 1, host: "h", ttlMin: 30 }); // live
    await insertHolder(engine, { id: "memex-cycle:x", pid: 2, host: "h", ttlMin: -5 }); // expired
    const stale = await listStaleLocks(engine);
    expect(stale.map((s) => s.id)).toEqual(["memex-cycle:x"]);
  });

  it("deleteLockRow removes by id+pid; deleteLockRowIfStale gates on age", async () => {
    await insertHolder(engine, { pid: 7, host: "h", ttlMin: 30, refreshedMin: 0 });
    // not stale enough → refused
    expect((await deleteLockRowIfStale(engine, CYCLE_LOCK_ID, 7, 600)).deleted).toBe(false);
    expect((await deleteLockRow(engine, CYCLE_LOCK_ID, 7)).deleted).toBe(true);
    expect((await deleteLockRow(engine, CYCLE_LOCK_ID, 7)).deleted).toBe(false); // idempotent
  });

  it("deleteLockRowExact only matches the snapshot's acquired_at", async () => {
    await insertHolder(engine, { pid: 9, host: "h", ageMin: 2, ttlMin: 30 });
    const snap = (await inspectLock(engine, CYCLE_LOCK_ID))!;
    // a stale acquired_at (off by minutes) must NOT match
    expect((await deleteLockRowExact(engine, CYCLE_LOCK_ID, 9, new Date(snap.acquired_at.getTime() - 60_000))).deleted).toBe(false);
    expect((await deleteLockRowExact(engine, CYCLE_LOCK_ID, 9, snap.acquired_at)).deleted).toBe(true);
  });

  it("reapDeadHolderLocks reaps a dead same-host cycle lock, keeps live / cross-host / out-of-namespace", async () => {
    const HOST = hostname();
    await insertHolder(engine, { id: "memex-cycle", pid: 100, host: HOST, ageMin: 5 }); // dead same-host → reap
    await insertHolder(engine, { id: "memex-cycle:live", pid: 101, host: HOST, ageMin: 5 }); // alive → keep
    await insertHolder(engine, { id: "memex-cycle:remote", pid: 102, host: "elsewhere", ageMin: 5 }); // cross-host → keep
    await insertHolder(engine, { id: "other-lock", pid: 103, host: HOST, ageMin: 5 }); // out of namespace → keep

    const { reapedIds } = await reapDeadHolderLocks(engine, { processKill: killSeam(100) });
    expect(reapedIds).toEqual(["memex-cycle"]);
    const left = await engine.query<{ id: string }>("SELECT id FROM cycle_locks ORDER BY id");
    expect(left.rows.map((r) => r.id)).toEqual(["memex-cycle:live", "memex-cycle:remote", "other-lock"]);
  });
});
