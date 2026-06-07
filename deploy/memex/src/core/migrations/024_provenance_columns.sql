-- 024_provenance_columns.sql — provenance + ranking-signal columns.
--
-- All `ADD COLUMN IF NOT EXISTS`, nullable or defaulted, so existing rows
-- are untouched and there is no behavior change. Consumers land in later
-- phases: emotional_weight + last_retrieved_at feed P2 ranking signals;
-- links_extracted_at + the links provenance columns feed P4 link
-- reconciliation; sources.archived/archive_expires_at/newest_content_at
-- feed P4 purge and P8 source-health. P0 only lays the columns.

ALTER TABLE pages
  -- emotional_weight is a deterministic 0..1 ranking score (REAL, like the
  -- recency/salience signals it sits beside); populated later by a cycle
  -- phase. REAL avoids any numeric-overflow edge if a future writer scales it.
  ADD COLUMN IF NOT EXISTS emotional_weight REAL NOT NULL DEFAULT 0.0,
  ADD COLUMN IF NOT EXISTS last_retrieved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS links_extracted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS contextual_retrieval_mode TEXT;

ALTER TABLE sources
  ADD COLUMN IF NOT EXISTS chunker_version TEXT,
  ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS archive_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS contextual_retrieval_mode TEXT,
  ADD COLUMN IF NOT EXISTS newest_content_at TIMESTAMPTZ;

ALTER TABLE links
  ADD COLUMN IF NOT EXISTS context TEXT,
  ADD COLUMN IF NOT EXISTS link_kind TEXT,
  ADD COLUMN IF NOT EXISTS origin_page_id TEXT,
  ADD COLUMN IF NOT EXISTS origin_field TEXT,
  ADD COLUMN IF NOT EXISTS resolution_type TEXT;
