/**
 * Generic DB-backed lock primitive.
 *
 * Faithful port of the reference's `db-lock`, adapted to memex's single unified
 * engine: the reference branches postgres (`sql`) vs PGLite (`db.query`) and
 * routes the refresh through a separate DIRECT session pool
 * (`executeRawDirect`) to survive a transaction-pooler exhaustion. memex has ONE
 * `engine.query` path and no second pool, so every branch collapses to it.
 *
 * Reuses the `cycle_locks` table (id PK + holder_pid + holder_host +
 * acquired_at + ttl_expires_at + last_refreshed_at) with a parameterized lock
 * id. The broad cycle lock (`memex-cycle`) lives here.
 *
 * Why not pg_advisory_xact_lock: it is session-scoped, and a transaction pooler
 * drops session state between calls. This row-based lock survives a pooler
 * because it's plain INSERT/UPDATE/DELETE with a TTL fallback (a crashed
 * holder's row times out).
 *
 * Acquire is upsert-style: empty RETURNING means the existing row is still live;
 * an expired holder (worker crashed without releasing) is auto-superseded by the
 * UPDATE branch. On top of the TTL fallback, `tryAcquireDbLock` adds an active
 * auto-takeover (reclaim a provably-dead same-host holder immediately, without
 * waiting out the TTL) and cleanup-registration (release the lock on abnormal
 * termination — every deploy SIGTERMs the container, so a held cycle lock would
 * otherwise linger until the TTL lapses).
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
 * Grace window before a provably-dead same-host holder becomes takeover-eligible
 * — defends against PID reuse (the OS reassigned the numeric PID to an unrelated
 * live process). A lock younger than this stays untouched even if its PID
 * probes dead.
 */
export const HOLDER_TAKEOVER_GRACE_MS = 60_000;

/**
 * Heartbeat-aware steal grace. A holder whose `last_refreshed_at` is within this
 * window is treated as ALIVE and is NOT stolen even if its `ttl_expires_at` has
 * lapsed — defending a live, actively refreshing holder whose refresh tick was
 * briefly starved (the thrash class where a CPU-bound import lets the TTL expire
 * and a competing launch steals the live lock). A genuinely dead holder stops
 * refreshing, ages past the grace, and becomes stealable again (TTL stays the
 * ultimate backstop). Derived from the TTL so it scales with the refresh
 * cadence; override with MEMEX_LOCK_STEAL_GRACE_SECONDS.
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
 * Liveness classification of a lock holder, from the perspective of the current
 * host. Shared by `isHolderDeadLocally` (auto-takeover) and any break-lock path
 * so the two never drift.
 *
 *   - `cross_host`    — holder is on a different host; `process.kill` is
 *                       meaningless remotely, never take over.
 *   - `alive`         — the PID exists (probe succeeded) OR the probe got EPERM
 *                       (the PID exists but isn't ours). EPERM-as-ALIVE is
 *                       load-bearing: stealing a live lock is the worst case.
 *   - `too_young`     — PID is provably dead (ESRCH) but the lock is younger
 *                       than the grace window (possible PID reuse).
 *   - `dead_eligible` — PID is provably dead AND the lock is old enough.
 *   - `unknown`       — the probe threw something other than ESRCH/EPERM;
 *                       conservative, treat as NOT eligible.
 */
export type HolderLiveness = "cross_host" | "alive" | "too_young" | "dead_eligible" | "unknown";

export interface HolderLivenessOpts {
  /** Grace window in ms (default HOLDER_TAKEOVER_GRACE_MS). */
  graceMs?: number;
  /** Override the local hostname (test seam; default `os.hostname()`). */
  localHost?: string;
  /** Override the liveness probe (test seam; default `process.kill`). */
  processKill?: (pid: number, signal: number) => void;
}

export function classifyHolderLiveness(
  holderPid: number,
  holderHost: string,
  ageMs: number,
  opts: HolderLivenessOpts = {},
): HolderLiveness {
  const localHost = opts.localHost ?? hostname();
  if (holderHost !== localHost) return "cross_host";

  const probe = opts.processKill ?? ((p: number, s: number) => process.kill(p, s));
  let probeResult: "alive" | "dead" | "eperm" | "unknown";
  try {
    probe(holderPid, 0);
    probeResult = "alive";
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    probeResult = code === "ESRCH" ? "dead" : code === "EPERM" ? "eperm" : "unknown";
  }

  // EPERM → the PID exists but isn't ours: treat as ALIVE, never steal.
  if (probeResult === "alive" || probeResult === "eperm") return "alive";
  if (probeResult === "unknown") return "unknown";

  // Provably dead (ESRCH). Gate on the grace window to defend against PID reuse.
  const grace = opts.graceMs ?? HOLDER_TAKEOVER_GRACE_MS;
  return ageMs < grace ? "too_young" : "dead_eligible";
}

/** Convenience boolean: is the holder provably dead, same-host, and past the grace window? */
export function isHolderDeadLocally(
  holderPid: number,
  holderHost: string,
  ageMs: number,
  opts: HolderLivenessOpts = {},
): boolean {
  return classifyHolderLiveness(holderPid, holderHost, ageMs, opts) === "dead_eligible";
}

/**
 * Is a lock-row holder live enough to count as "running" for an observability
 * surface? PID-reuse-safe by design: keys on the lock's own freshness, NEVER
 * `process.kill`. A live holder refreshes its TTL on a timer; a dead one stops,
 * so its `ttl_expires_at` lapses and (after the steal grace) `last_refreshed_at`
 * ages out. The primary signal is `!ttl_expired`; the heartbeat grace covers a
 * starved-but-alive holder whose TTL briefly lapsed between refresh ticks,
 * mirroring the steal-grace semantics `tryAcquireDbLock` already uses.
 * Cross-host holders are still "running" for visibility — we report freshness,
 * not takeover-eligibility, so host is not consulted here.
 */
export function isLockHolderLive(snap: LockSnapshot, ttlMinutes: number = DEFAULT_TTL_MINUTES): boolean {
  if (!snap.ttl_expired) return true;
  if (snap.ms_since_last_refresh !== null) {
    return snap.ms_since_last_refresh < resolveStealGraceSeconds(ttlMinutes) * 1000;
  }
  return false;
}

/**
 * Try to acquire a named DB lock.
 *
 * Returns a handle on success. Returns `null` if another live holder has the
 * lock (its row exists and ttl_expires_at is in the future).
 *
 * The acquire is upsert-style:
 *   INSERT ... ON CONFLICT (id) DO UPDATE
 *     ... WHERE existing.ttl_expires_at < NOW()
 *   RETURNING id
 *
 * Empty RETURNING means the existing row is still live. An expired holder
 * (worker crashed without releasing) is auto-superseded by the UPDATE branch; a
 * provably-dead same-host holder whose TTL has NOT yet lapsed is reclaimed by
 * the auto-takeover fallback below.
 */
export async function tryAcquireDbLock(
  engine: Engine,
  lockId: string,
  ttlMinutes: number = DEFAULT_TTL_MINUTES,
): Promise<DbLockHandle | null> {
  const pid = process.pid;
  const host = hostname();
  // A holder that refreshed within this window is protected from the ON CONFLICT
  // steal even if its TTL lapsed (starved-but-alive).
  const stealGraceSeconds = resolveStealGraceSeconds(ttlMinutes);
  const ttl = `${ttlMinutes} minutes`;

  // Auto-register cleanup so abnormal termination (SIGTERM/SIGHUP/SIGPIPE/
  // uncaughtException) releases the lock instead of leaking it until the TTL.
  // The returned handle's release() deregisters before deleting — atomic in
  // single-threaded JS, so no double-DELETE on the normal exit path.
  const { registerCleanup } = await import("./process-cleanup.ts");

  const acquireOnce = async (): Promise<DbLockHandle | null> => {
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

    const deregister = registerCleanup(`db-lock:${lockId}`, async () => {
      await engine.query(`DELETE FROM cycle_locks WHERE id = $1 AND holder_pid = $2`, [lockId, pid]);
    });

    return {
      id: lockId,
      refresh: async () => {
        // Bump BOTH ttl_expires_at AND last_refreshed_at. The reference routes
        // this through a DIRECT session pool to survive pooler exhaustion;
        // memex has a single pool, so engine.query is the faithful adaptation.
        await engine.query(
          `UPDATE cycle_locks
              SET ttl_expires_at = NOW() + ($1)::interval,
                  last_refreshed_at = NOW()
            WHERE id = $2 AND holder_pid = $3`,
          [ttl, lockId, pid],
        );
      },
      release: async () => {
        deregister();
        await engine.query(`DELETE FROM cycle_locks WHERE id = $1 AND holder_pid = $2`, [lockId, pid]);
      },
    };
  };

  const first = await acquireOnce();
  if (first) return first;

  // The lock is held and its TTL hasn't expired (the upsert's ON CONFLICT ...
  // WHERE ttl_expires_at < NOW() returned no row). If the holder is on THIS
  // host, provably dead, and past the grace window, reclaim it: guarded DELETE
  // then retry the normal upsert ONCE. The retry returns the normal handle
  // (refresh/release intact). TTL-expired holders are NOT handled here (the
  // upsert already takes them); cross-host holders stay TTL-only. Best-effort:
  // any error falls through to `return null` (busy), exactly as before.
  try {
    const snap = await inspectLock(engine, lockId);
    if (snap && !snap.ttl_expired && isHolderDeadLocally(snap.holder_pid, snap.holder_host, snap.age_ms)) {
      const { deleted } = await deleteLockRow(engine, lockId, snap.holder_pid);
      if (deleted) {
        const second = await acquireOnce();
        if (second) return second;
      }
    }
  } catch {
    // Auto-takeover is best-effort; never throw from the acquire path.
  }
  return null;
}

export interface LockSnapshot {
  id: string;
  holder_pid: number;
  holder_host: string;
  acquired_at: Date;
  ttl_expires_at: Date;
  age_ms: number;
  /** TTL has already expired — lock is structurally available for next acquire. */
  ttl_expired: boolean;
  /** Timestamp of the most recent refresh() tick (or null when no acquire has
   *  written it). The heartbeat signal: a healthy holder has a recent value; a
   *  wedged-but-alive holder (JS interval stopped) has a stale one. */
  last_refreshed_at: Date | null;
  /** ms since the most recent refresh, or null when last_refreshed_at is null. */
  ms_since_last_refresh: number | null;
}

/** Raw row shape returned by every `cycle_locks` SELECT. */
interface RawLockRow {
  id?: string;
  holder_pid?: number;
  holder_host?: string;
  acquired_at?: Date | string;
  ttl_expires_at?: Date | string;
  last_refreshed_at?: Date | string | null;
}

/** Canonical column list for every lock SELECT — keep in lockstep with `RawLockRow`. */
const LOCK_SELECT_COLS = "id, holder_pid, holder_host, acquired_at, ttl_expires_at, last_refreshed_at";

/**
 * Row → `LockSnapshot` mapper. Coerces Date|string columns to Date and computes
 * the derived fields (age_ms, ttl_expired, ms_since_last_refresh). Returns null
 * for a structurally-incomplete row (missing pid / acquired_at / ttl).
 */
function rowToLockSnapshot(row: RawLockRow, now: number): LockSnapshot | null {
  if (row.holder_pid === undefined || !row.acquired_at || !row.ttl_expires_at) return null;
  const acquired = row.acquired_at instanceof Date ? row.acquired_at : new Date(row.acquired_at);
  const ttlExpires = row.ttl_expires_at instanceof Date ? row.ttl_expires_at : new Date(row.ttl_expires_at);
  const lastRefreshed =
    row.last_refreshed_at == null
      ? null
      : row.last_refreshed_at instanceof Date
        ? row.last_refreshed_at
        : new Date(row.last_refreshed_at);
  return {
    id: String(row.id ?? ""),
    holder_pid: Number(row.holder_pid),
    holder_host: String(row.holder_host ?? ""),
    acquired_at: acquired,
    ttl_expires_at: ttlExpires,
    age_ms: now - acquired.getTime(),
    ttl_expired: ttlExpires.getTime() < now,
    last_refreshed_at: lastRefreshed,
    ms_since_last_refresh: lastRefreshed ? now - lastRefreshed.getTime() : null,
  };
}

interface SelectLockRowsOpts {
  /** Return only the row for this exact lock id (the `inspectLock` case). */
  lockId?: string;
  /** Return only rows whose ttl_expires_at < NOW() (the `listStaleLocks` case). */
  staleOnly?: boolean;
}

/**
 * The single canonical reader for `cycle_locks` so `inspectLock`,
 * `listStaleLocks`, and the reaper don't each re-roll the SELECT + Date
 * coercion. Returns fully-mapped `LockSnapshot[]`; the table holds 0-2 rows in
 * practice, so the read is cheap.
 */
async function selectLockRows(engine: Engine, opts: SelectLockRowsOpts = {}): Promise<LockSnapshot[]> {
  let rows: RawLockRow[];
  if (opts.lockId !== undefined) {
    rows = (await engine.query<RawLockRow>(`SELECT ${LOCK_SELECT_COLS} FROM cycle_locks WHERE id = $1`, [opts.lockId])).rows;
  } else if (opts.staleOnly) {
    rows = (await engine.query<RawLockRow>(`SELECT ${LOCK_SELECT_COLS} FROM cycle_locks WHERE ttl_expires_at < NOW() ORDER BY acquired_at`)).rows;
  } else {
    rows = (await engine.query<RawLockRow>(`SELECT ${LOCK_SELECT_COLS} FROM cycle_locks ORDER BY acquired_at`)).rows;
  }

  const now = Date.now();
  return rows.map((r) => rowToLockSnapshot(r, now)).filter((s): s is LockSnapshot => s !== null);
}

/** Inspect the current holder of a named lock. Pure read; no acquire. */
export async function inspectLock(engine: Engine, lockId: string): Promise<LockSnapshot | null> {
  const rows = await selectLockRows(engine, { lockId });
  return rows[0] ?? null;
}

/** List every lock whose TTL has expired. Reuses the same canonical staleness
 *  signal (ttl_expires_at < NOW()) the acquire UPDATE-on-conflict trusts. */
export async function listStaleLocks(engine: Engine): Promise<LockSnapshot[]> {
  return selectLockRows(engine, { staleOnly: true });
}

/**
 * Atomic verify-and-delete: `DELETE ... WHERE id = $1 AND holder_pid = $2
 * RETURNING id`. A returned row means we cleared the lock; an empty array means
 * the row was already cleared (idempotent). Single round-trip; no TOCTOU window.
 * The caller owns the liveness check.
 */
export async function deleteLockRow(
  engine: Engine,
  lockId: string,
  holderPid: number,
): Promise<{ deleted: boolean }> {
  const { rows } = await engine.query<{ id: string }>(
    `DELETE FROM cycle_locks WHERE id = $1 AND holder_pid = $2 RETURNING id`,
    [lockId, holderPid],
  );
  return { deleted: rows.length > 0 };
}

/**
 * Atomic age-gated verify-and-delete for a `--break-lock --max-age <seconds>`
 * path. Matches id + holder_pid + a `last_refreshed_at` older than
 * maxAgeSeconds in ONE statement (no TOCTOU): a healthy holder refreshes every
 * ~ttl/6, so only a wedged-but-alive holder (JS interval stopped) shows a stale
 * value. `$3 * INTERVAL '1 second'` (not `$3::interval`) is the canonical idiom
 * that works on both Postgres and PGLite. RETURNING last_refreshed_at so the
 * caller can report the actual stale age.
 */
export async function deleteLockRowIfStale(
  engine: Engine,
  lockId: string,
  holderPid: number,
  maxAgeSeconds: number,
): Promise<{ deleted: boolean; lastRefreshedAt: Date | null }> {
  const { rows } = await engine.query<{ id: string; last_refreshed_at: Date | string | null }>(
    `DELETE FROM cycle_locks
      WHERE id = $1
        AND holder_pid = $2
        AND last_refreshed_at IS NOT NULL
        AND last_refreshed_at < NOW() - $3 * INTERVAL '1 second'
     RETURNING id, last_refreshed_at`,
    [lockId, holderPid, maxAgeSeconds],
  );
  if (rows.length === 0) return { deleted: false, lastRefreshedAt: null };
  const lr = rows[0]!.last_refreshed_at;
  const lastRefreshed = lr == null ? null : lr instanceof Date ? lr : new Date(lr);
  return { deleted: true, lastRefreshedAt: lastRefreshed };
}

/**
 * Snapshot-matched verify-and-delete for the background reaper. Unlike
 * `deleteLockRow` (id + holder_pid only), this ALSO pins the observed
 * `acquired_at`, closing the TOCTOU window the reaper opens by reading rows
 * before deleting them: between the SELECT and the DELETE, the dead holder's row
 * could be replaced by a NEW holder that reused the same numeric PID. That new
 * row carries a newer `acquired_at`, so the match fails and the DELETE is a safe
 * no-op. `date_trunc('milliseconds', acquired_at)` (not bare equality) because a
 * driver parses timestamptz into a ms-precision JS Date, losing the microseconds
 * `NOW()` writes — truncating both sides makes the comparison round-trip-safe on
 * Postgres + PGLite while a real takeover (seconds later) still differs.
 */
export async function deleteLockRowExact(
  engine: Engine,
  lockId: string,
  holderPid: number,
  acquiredAt: Date,
): Promise<{ deleted: boolean }> {
  const { rows } = await engine.query<{ id: string }>(
    `DELETE FROM cycle_locks
      WHERE id = $1
        AND holder_pid = $2
        AND date_trunc('milliseconds', acquired_at) = $3
     RETURNING id`,
    [lockId, holderPid, acquiredAt],
  );
  return { deleted: rows.length > 0 };
}

/**
 * Host-scoped reaper for dead-holder locks. Closes the gap where a cycle that
 * crashed (OOM, recycle, SIGKILL) strands its lock row until something contends
 * for it. `tryAcquireDbLock` only reclaims on contention; this is the background
 * sweep, intended to run at cycle start.
 *
 * Scoped to the `memex-cycle`/`memex-cycle:*` namespace ONLY — `cycle_locks` is
 * a shared table, so a blanket sweep would change another lock kind's TTL-
 * failover timing.
 */
function isReapableNamespace(lockId: string): boolean {
  return lockId === "memex-cycle" || lockId.startsWith("memex-cycle:");
}

export async function reapDeadHolderLocks(
  engine: Engine,
  opts: HolderLivenessOpts = {},
): Promise<{ reaped: number; reapedIds: string[] }> {
  const rows = await selectLockRows(engine);
  const reapedIds: string[] = [];
  for (const s of rows) {
    if (!isReapableNamespace(s.id)) continue;
    // isHolderDeadLocally combines same-host + ESRCH + the grace window, so
    // pure-PID-liveness (which PID-space wrap defeats) is never used alone.
    if (!isHolderDeadLocally(s.holder_pid, s.holder_host, s.age_ms, opts)) continue;
    const { deleted } = await deleteLockRowExact(engine, s.id, s.holder_pid, s.acquired_at);
    if (deleted) reapedIds.push(s.id);
  }
  return { reaped: reapedIds.length, reapedIds };
}
