-- 080_effective_date_provenance.sql — where a content date came from, plus the
-- salience-window touch stamp (reference parity: effective_date_source /
-- import_filename / salience_touched_at).
--
-- documents.effective_date (mig055) records WHAT the content date is but not
-- WHERE it came from, so a doctor effective_date_health check cannot tell
-- "parsed from frontmatter" apart from "guessed off the filename" apart from
-- "no date at all (fallback to updated_at)". The reference stores a sentinel:
--   'date' | 'event_date' | 'published'  — the winning frontmatter key
--   'filename'                           — YYYY-MM-DD parsed from the path
--   'fallback'                           — nothing parsed; COALESCE uses
--                                          updated_at at read time
-- import_filename preserves the original basename the doc was ingested from,
-- so the filename-derivation is auditable after renames/moves.
--
-- pages.salience_touched_at is bumped by the recompute-salience cycle phase
-- whenever a page's salience actually CHANGES, so a salience-window consumer
-- can pick up newly-salient old pages without diffing scores.
--
-- GRANDFATHER: no backfill. Existing docs keep NULL sentinel (unknown
-- provenance) until their next re-index parses one; pages keep NULL touch
-- until the next salience change. Purely additive, LLM-free.

ALTER TABLE documents ADD COLUMN IF NOT EXISTS effective_date_source TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS import_filename       TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'documents_effective_date_source_chk'
       AND conrelid = 'documents'::regclass
  ) THEN
    ALTER TABLE documents
      ADD CONSTRAINT documents_effective_date_source_chk
      CHECK (effective_date_source IS NULL OR effective_date_source IN
        ('date', 'event_date', 'published', 'filename', 'fallback'));
  END IF;
END $$;

ALTER TABLE pages ADD COLUMN IF NOT EXISTS salience_touched_at TIMESTAMPTZ;
