-- 039_jobs_timeout.sql -- per-job hard wall-clock timeout (dead-letter on
-- exceed), distinct from the stall/lock-expiry requeue path.
--
-- `lock_until` + `handleStalled` recover a job whose WORKER died (the lock
-- expires and the row is requeued, bounded by `max_stalled`). They do NOT bound
-- a job whose HANDLER wedges while the worker is alive: in memex's single-worker
-- loop a handler that never returns holds the one in-flight slot forever, so no
-- further job is claimed even though the stall sweep keeps running. A per-job
-- `timeout_ms` lets the worker race the handler against a hard wall-clock cap
-- and DEAD-LETTER (terminal fail, no retry) a job that exceeds it, freeing the
-- worker.
--
-- NULL = no per-job cap; the worker's process-wide default (off unless
-- `MEMEX_JOB_TIMEOUT_MS` is set) then applies. Additive + nullable: existing
-- rows and the no-timeout default keep today's behavior exactly.

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS timeout_ms INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'jobs_timeout_ms_chk'
       AND conrelid = 'jobs'::regclass
  ) THEN
    ALTER TABLE jobs
      ADD CONSTRAINT jobs_timeout_ms_chk
      CHECK (timeout_ms IS NULL OR timeout_ms > 0);
  END IF;
END $$;
