-- 083: jobs lifecycle surface — progress + per-job token/cost accounting.
--
-- The jobs table grows unbounded (no prune path existed) and a paid job's
-- Bedrock spend is invisible once it finishes. Reference parity:
--
--   - `progress`           : structured handler-reported progress (JSONB),
--     readable while the job runs (MCP get_job_progress).
--   - `tokens_input/output/cache_read` : per-job LLM token tally, accumulated
--     by the handler via the worker context (reference carries the same three
--     columns on its job rows).
--   - `cost_usd`           : accumulated dollar estimate for paid calls, so
--     `jobs list` / stats can answer "what did this job cost?" without
--     re-deriving prices from token counts later.
--
-- Additive + idempotent. Defaults of 0 keep existing rows and non-LLM jobs
-- exactly as before.

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS progress JSONB;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS tokens_input INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS tokens_output INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS tokens_cache_read INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS cost_usd NUMERIC(12,6) NOT NULL DEFAULT 0;

-- Prune sweep filters on terminal status + age.
CREATE INDEX IF NOT EXISTS jobs_prune_idx ON jobs (status, updated_at);
