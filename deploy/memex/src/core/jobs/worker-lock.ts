/**
 * Worker lock — elects a single active job worker via a singleton DB row
 * (migration 042) and carries a heartbeat for wedge detection.
 *
 * Plain `engine.query` upserts only (no advisory locks — session-scoped, die
 * under a transaction pooler). A worker acquires the row, heartbeats it each
 * tick, and releases on stop; a stale heartbeat (holder crashed or wedged) lets
 * a survivor steal the lock once the TTL lapses.
 */
import type { Engine } from "../engine/interface.ts";

/** Default singleton lock id for the maintenance/job worker. */
export const DEFAULT_WORKER_LOCK_ID = "memex-jobs-worker";

/**
 * Acquire (or re-acquire / steal-if-stale) the lock for `holder`. Returns true
 * when `holder` now owns it. Own lock → always re-acquired; another live
 * holder (fresh heartbeat) → false; stale holder → stolen.
 */
export async function acquireWorkerLock(
  engine: Engine,
  id: string,
  holder: string,
  ttlSeconds: number,
): Promise<boolean> {
  const r = await engine.query<{ id: string }>(
    `INSERT INTO worker_lock (id, holder, acquired_at, heartbeat_at, ttl_seconds)
     VALUES ($1, $2, NOW(), NOW(), $3)
     ON CONFLICT (id) DO UPDATE
       SET holder = $2, acquired_at = NOW(), heartbeat_at = NOW(), ttl_seconds = $3
       WHERE worker_lock.holder = $2
          OR worker_lock.heartbeat_at
             < NOW() - (worker_lock.ttl_seconds || ' seconds')::interval
     RETURNING id`,
    [id, holder, ttlSeconds],
  );
  return r.rows.length > 0;
}

/**
 * Bump the heartbeat. Returns false when `holder` no longer owns the row (a
 * survivor stole it after a lapse) — the caller should treat the lock as lost.
 */
export async function heartbeatWorkerLock(
  engine: Engine,
  id: string,
  holder: string,
): Promise<boolean> {
  const r = await engine.query<{ id: string }>(
    `UPDATE worker_lock SET heartbeat_at = NOW()
      WHERE id = $1 AND holder = $2 RETURNING id`,
    [id, holder],
  );
  return r.rows.length > 0;
}

/** Release the lock iff `holder` still owns it. Idempotent. */
export async function releaseWorkerLock(
  engine: Engine,
  id: string,
  holder: string,
): Promise<void> {
  await engine.query(`DELETE FROM worker_lock WHERE id = $1 AND holder = $2`, [
    id,
    holder,
  ]);
}

export interface WorkerLockStatus {
  holder: string;
  heartbeatAt: string;
  staleMs: number;
  ttlSeconds: number;
  /** True when the heartbeat is older than the TTL — holder crashed or wedged. */
  stale: boolean;
}

/** Read the current lock holder + heartbeat staleness (read-only; for status). */
export async function readWorkerLock(
  engine: Engine,
  id: string,
): Promise<WorkerLockStatus | null> {
  const r = await engine.query<{
    holder: string;
    heartbeat_at: string;
    stale_ms: number;
    ttl_seconds: number;
  }>(
    `SELECT holder, heartbeat_at::text AS heartbeat_at,
            (EXTRACT(EPOCH FROM (NOW() - heartbeat_at)) * 1000)::bigint AS stale_ms,
            ttl_seconds
       FROM worker_lock WHERE id = $1`,
    [id],
  );
  const row = r.rows[0];
  if (!row) return null;
  const staleMs = Number(row.stale_ms);
  return {
    holder: row.holder,
    heartbeatAt: row.heartbeat_at,
    staleMs,
    ttlSeconds: row.ttl_seconds,
    stale: staleMs > row.ttl_seconds * 1000,
  };
}
