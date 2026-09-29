-- 050_cycle_locks.sql — DB-backed lock table for cycle concurrency control.
--
-- A single-row-per-lock-id table that serializes the maintenance cycle across
-- processes. Acquire is an upsert with a TTL fallback (a crashed holder's row
-- times out), so it survives a transaction pooler that drops session state
-- between calls — unlike pg_advisory_xact_lock. See src/core/db-lock.ts.
--
-- PGLite-safe: TEXT/INT/TIMESTAMPTZ + NOW() + intervals only; no extensions.
CREATE TABLE IF NOT EXISTS cycle_locks (
  id                TEXT PRIMARY KEY,
  holder_pid        INT NOT NULL,
  holder_host       TEXT,
  acquired_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ttl_expires_at    TIMESTAMPTZ NOT NULL,
  last_refreshed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_cycle_locks_ttl ON cycle_locks(ttl_expires_at);
