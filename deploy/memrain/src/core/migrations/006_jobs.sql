-- memex schema migration 006: durable job queue.
--
-- Replaces the implicit single-timer cycle loop in `core/cycle/` with a
-- table-backed queue. Lets us add Gmail / GCal / Telegram-ingestion
-- recipes without a single slow API call stalling everything else.
--
-- Atomic claim is via the `UPDATE … WHERE id = (SELECT … FOR UPDATE
-- SKIP LOCKED LIMIT 1) RETURNING *` pattern (works on Postgres 9.5+ and
-- PGLite). Higher-priority = lower number; default 5.

CREATE TABLE IF NOT EXISTS jobs (
  id                TEXT PRIMARY KEY,
  kind              TEXT NOT NULL,
  payload           JSONB NOT NULL DEFAULT '{}'::jsonb,
  status            TEXT NOT NULL DEFAULT 'pending',
  priority          INTEGER NOT NULL DEFAULT 5,
  retry_count       INTEGER NOT NULL DEFAULT 0,
  max_retries       INTEGER NOT NULL DEFAULT 3,
  next_attempt_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  quiet_hours_skip  BOOLEAN NOT NULL DEFAULT FALSE,
  last_error        TEXT,
  result            JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at        TIMESTAMPTZ,
  finished_at       TIMESTAMPTZ,
  CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')),
  CHECK (priority BETWEEN 1 AND 10),
  CHECK (retry_count >= 0),
  CHECK (max_retries >= 0)
);

-- Hot path for claim: filter pending + due, order by priority/due-time.
-- Postgres uses partial-index optimisation; PGLite ignores the WHERE
-- clause but still benefits from the leading status column.
CREATE INDEX IF NOT EXISTS jobs_due_idx
  ON jobs (status, next_attempt_at, priority)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS jobs_kind_idx
  ON jobs (kind);

CREATE INDEX IF NOT EXISTS jobs_created_at_idx
  ON jobs (created_at DESC);
