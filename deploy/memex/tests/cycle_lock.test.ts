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
import { PGliteEngine } from "../src/core/engine/pglite.ts";
import { runMigrations } from "../src/core/migrate.ts";
import { CYCLE_LOCK_ID, tryAcquireDbLock } from "../src/core/db-lock.ts";

const MIGRATIONS_DIR = join(import.meta.dir, "../src/core/migrations");

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
});
