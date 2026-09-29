-- 115_job_authority.sql — who submitted a job, and under what grant.
--
-- A tenant can hand the brain an agent task. The worker must run it as that
-- tenant, not as the operator, and must stop it once the grant behind it is
-- revoked or changed. `submitted_by` is the OAuth client that submitted the
-- job; `authority` is the grant snapshot taken at submit (client, spender,
-- grant revision, sources, tools, payload hash) that the worker re-checks
-- against the live client row at claim and before every model call and tool.
--
-- Additive; operator jobs keep NULL in both columns. The partial index serves
-- the per-client concurrency count at submit and the owner lookup.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS submitted_by TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS authority JSONB;

CREATE INDEX IF NOT EXISTS idx_jobs_submitted_by_status
  ON jobs (submitted_by, status)
  WHERE submitted_by IS NOT NULL;
