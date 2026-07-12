-- 087_ingest_log_source_id.sql — tenant axis on the ingestion audit log
-- (adds ingest_log.source_id).
--
-- ingest_log (mig023) predates the mig047 tenancy sweep and never got the
-- column — so per-source failure accounting (the facts:absorb durable writer,
-- a future doctor facts_extraction_health check) had nowhere to scope. Same
-- NOT NULL DEFAULT 'default' idiom as every other mig047 table: existing rows
-- backfill atomically to the legacy tenant.
--
-- The composite index covers the two hot reads: "recent absorb failures for
-- source X" (source_id, source_type leading) and the per-source recent-log
-- listing. The mig023 (source_type, created_at DESC) index stays for legacy
-- unscoped reads.

ALTER TABLE ingest_log
  ADD COLUMN IF NOT EXISTS source_id TEXT NOT NULL DEFAULT 'default';

CREATE INDEX IF NOT EXISTS ingest_log_source_id_type_idx
  ON ingest_log (source_id, source_type, created_at DESC);
