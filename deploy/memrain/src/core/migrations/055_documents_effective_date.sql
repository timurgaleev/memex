-- 055_documents_effective_date.sql — content-date temporal axis on the LIVE
-- retrieval model (documents).
--
-- `updated_at` is the INGEST clock (when memex last wrote the row); it is the
-- wrong axis for "what happened in March" — a note about a March event imported
-- in June ranks/filters as June. `effective_date` is the CONTENT date, parsed
-- deterministically at ingest from frontmatter (date / event_date / published)
-- or the filename. The `since`/`until` search filter ranks on
-- COALESCE(effective_date, updated_at), so un-dated docs fall back to the
-- ingest clock and behave exactly as before.
--
-- GRANDFATHER: no backfill. Existing docs get NULL → COALESCE picks updated_at,
-- so retrieval is unchanged until a re-index parses a content date. Pure
-- additive, LLM-free.
--
-- PGLite-safe: ADD COLUMN with no DEFAULT (NULL) is metadata-only; the
-- expression index over COALESCE(effective_date, updated_at) backs the
-- since/until range scan.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS effective_date TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_documents_effective_date
  ON documents ((COALESCE(effective_date, updated_at)));
