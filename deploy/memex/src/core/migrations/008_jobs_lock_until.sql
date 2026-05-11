-- memex schema migration 008: stall detection for jobs.
--
-- Without this, a worker that dies mid-job (OOM, container kill, hard
-- panic) leaves the row in `running` forever. The next worker can't
-- claim it because the partial-index for pending excludes running
-- rows, and `cancel/retry` need a human in the loop.
--
-- `lock_until` is set when claim flips a row to running. A separate
-- `handleStalled(now)` query requeues rows where lock_until < now,
-- bounded by `max_stalled` so a chronically failing job eventually
-- terminal-fails instead of looping forever.

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS lock_until    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS stall_count   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_stalled   INTEGER NOT NULL DEFAULT 5;

-- Index that lets handleStalled find candidates cheaply.
CREATE INDEX IF NOT EXISTS jobs_running_lock_idx
  ON jobs (status, lock_until)
  WHERE status = 'running';
