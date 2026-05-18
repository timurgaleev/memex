-- 019_jobs_dag.sql -- extend jobs for DAG/fan-out + idempotent submit.
--
-- The existing `jobs` table (migration 006) is flat: each row is a
-- standalone unit of work. For multi-step pipelines the agent often
-- wants to fan out (parent submits N children, waits for all to
-- finish, then aggregates) without re-running children if the parent
-- is retried. This migration adds the three pieces needed:
--
--   1. `jobs.parent_job_id` -- nullable FK to jobs.id, on-delete SET
--      NULL so an explicit parent purge does not orphan-cascade
--      children (they keep running, just become orphans in the
--      audit trail).
--   2. `jobs.depth` -- how many ancestors above this job. A guard for
--      runaway recursion; handlers should refuse depth > N.
--   3. `jobs.idempotency_key` + a partial UNIQUE -- a stable token a
--      caller passes when submitting. If a key has already been used
--      for the same `kind`, the submit returns the existing row
--      instead of creating a duplicate. Critical for at-least-once
--      delivery from recipes (an email-poll cron that retries on
--      transient failure must not re-process the same email twice).
--
-- Two new tables:
--
--   * `job_children` -- denormalised parent->child edge. Lets a
--     parent ask "what children did I spawn?" with one index hit
--     instead of scanning the whole jobs table.
--   * `child_done_inbox` -- write-once notification of child
--     completion. The job worker, on transitioning a row to
--     succeeded/failed/cancelled, inserts a row here keyed on the
--     parent. A waiting parent drains the inbox to know when all
--     children are accounted for. Outbox-style ledger keeps fan-in
--     async + crash-safe.

-- FK delete behaviour: SET NULL on parent purge keeps the child
-- row inspectable (parent_job_id -> NULL) but the edge tables below
-- CASCADE. The asymmetry is intentional today (no public job-delete
-- endpoint exists) but flagged in TODO.md to align before we expose
-- one -- either all three CASCADE (purge subtree) or explicit
-- "refuse parent delete with live children" guard.
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS parent_job_id    TEXT
    REFERENCES jobs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS depth            INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS idempotency_key  TEXT;

-- Index makes parent->children lookup O(log n) without job_children.
-- (job_children is the denormalised fan-out path; this index is the
-- backstop for ad-hoc "show me all my children" queries.)
CREATE INDEX IF NOT EXISTS jobs_parent_id_idx
  ON jobs(parent_job_id)
  WHERE parent_job_id IS NOT NULL;

-- Idempotency: same (kind, idempotency_key) submitted twice returns
-- the row that already exists. Partial index so NULL keys (the
-- common case for one-off jobs) coexist freely.
CREATE UNIQUE INDEX IF NOT EXISTS jobs_idempotency_key_uniq
  ON jobs(kind, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS job_children (
  parent_id   TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  child_id    TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (parent_id, child_id)
);

CREATE INDEX IF NOT EXISTS job_children_child_idx
  ON job_children(child_id);

-- Inbox of finished children. The parent job's handler polls this
-- table (filtering by parent_id) to learn which fan-out children
-- have finished. `notified_at` is updated when the parent has
-- observed a row -- before that it acts as the "unread" mark.
--
-- Rows are deleted only by the parent (after fan-in is complete);
-- the cascade-on-jobs-delete keeps things honest if the whole
-- subtree is purged.
CREATE TABLE IF NOT EXISTS child_done_inbox (
  parent_id      TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  child_id       TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  child_status   TEXT NOT NULL CHECK (
    child_status IN ('succeeded','failed','cancelled')
  ),
  result_excerpt TEXT,
  completed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notified_at    TIMESTAMPTZ,
  PRIMARY KEY (parent_id, child_id)
);

CREATE INDEX IF NOT EXISTS child_done_inbox_unread_idx
  ON child_done_inbox(parent_id, completed_at)
  WHERE notified_at IS NULL;
