/**
 * Generic DB-backed lock primitive.
 *
 * Reuses the cycle_locks table (id PK + holder_pid + ttl_expires_at) with a
 * parameterized lock id. The broad cycle lock (`memex-cycle`) lives here.
 *
 * Why not pg_advisory_xact_lock: it is session-scoped, and a transaction
 * pooler drops session state between calls. This row-based lock survives a
 * pooler because it's plain INSERT/UPDATE/DELETE with a TTL fallback (a
 * crashed holder's row times out).
 *
 * Empty RETURNING means the existing row is still live. An expired holder
 * (worker crashed without releasing) is auto-superseded by the UPDATE branch.
 */
import { hostname } from "os";
import type { Engine } from "./engine/interface.ts";

export interface DbLockHandle {
  id: string;
  release: () => Promise<void>;
  refresh: () => Promise<void>;
}

/** Lock id for the broad cycle lock — serializes a single cycle invocation. */
export const CYCLE_LOCK_ID = "memex-cycle";

/** Default TTL: 30 minutes, same as cycle lock. */
const DEFAULT_TTL_MINUTES = 30;

/**
 * Heartbeat-aware steal grace. A holder whose `last_refreshed_at` is within
 * this window is treated as ALIVE and is NOT stolen even if its
 * `ttl_expires_at` has lapsed — defending a live, actively refreshing holder
 * whose refresh tick was briefly starved (the thrash class where a CPU-bound
 * import lets the TTL expire and a competing launch steals the live lock). A
 * genuinely dead holder stops refreshing, ages past the grace, and becomes
 * stealable again (TTL stays the ultimate backstop). Derived from the TTL so
 * it scales with the refresh cadence; override with
 * MEMEX_LOCK_STEAL_GRACE_SECONDS.
 */
export const DEFAULT_STEAL_GRACE_SECONDS = 600;

export function resolveStealGraceSeconds(ttlMinutes: number): number {
  const raw = process.env.MEMEX_LOCK_STEAL_GRACE_SECONDS;
  if (raw) {
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0) return n;
  }
  // Refresh fires ~ttl/6; protect a holder that refreshed within ~2 ticks.
  const refreshSec = Math.max(15, (ttlMinutes * 60) / 6);
  return Math.max(Math.floor(refreshSec * 2), 60);
}

/**
 * Try to acquire a named DB lock.
 *
 * Returns a handle on success. Returns `null` if another live holder has
 * the lock (its row exists and ttl_expires_at is in the future).
 *
 * The acquire is upsert-style:
 *   INSERT ... ON CONFLICT (id) DO UPDATE
 *     ... WHERE existing.ttl_expires_at < NOW()
 *   RETURNING id
 *
 * Empty RETURNING means the existing row is still live. An expired holder
 * (worker crashed without releasing) is auto-superseded by the UPDATE branch.
 */
export async function tryAcquireDbLock(
  engine: Engine,
  lockId: string,
  ttlMinutes: number = DEFAULT_TTL_MINUTES,
): Promise<DbLockHandle | null> {
  const pid = process.pid;
  const host = hostname();
  // A holder that refreshed within this window is protected from the ON
  // CONFLICT steal even if its TTL lapsed (starved-but-alive).
  const stealGraceSeconds = resolveStealGraceSeconds(ttlMinutes);
  const ttl = `${ttlMinutes} minutes`;

  // last_refreshed_at = acquired_at on initial INSERT; every refresh() tick
  // bumps both ttl_expires_at AND last_refreshed_at.
  const { rows } = await engine.query<{ id: string }>(
    `INSERT INTO cycle_locks (id, holder_pid, holder_host, acquired_at, ttl_expires_at, last_refreshed_at)
     VALUES ($1, $2, $3, NOW(), NOW() + ($4)::interval, NOW())
     ON CONFLICT (id) DO UPDATE
       SET holder_pid = $2,
           holder_host = $3,
           acquired_at = NOW(),
           ttl_expires_at = NOW() + ($4)::interval,
           last_refreshed_at = NOW()
       WHERE cycle_locks.ttl_expires_at < NOW()
         AND (cycle_locks.last_refreshed_at IS NULL
              OR cycle_locks.last_refreshed_at < NOW() - $5 * INTERVAL '1 second')
     RETURNING id`,
    [lockId, pid, host, ttl, stealGraceSeconds],
  );
  if (rows.length === 0) return null;

  return {
    id: lockId,
    refresh: async () => {
      // Bump BOTH ttl_expires_at AND last_refreshed_at.
      await engine.query(
        `UPDATE cycle_locks
            SET ttl_expires_at = NOW() + ($1)::interval,
                last_refreshed_at = NOW()
          WHERE id = $2 AND holder_pid = $3`,
        [ttl, lockId, pid],
      );
    },
    release: async () => {
      await engine.query(
        `DELETE FROM cycle_locks WHERE id = $1 AND holder_pid = $2`,
        [lockId, pid],
      );
    },
  };
}
