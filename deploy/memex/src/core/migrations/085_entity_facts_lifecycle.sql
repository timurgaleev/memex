-- 085_entity_facts_lifecycle.sql — fact lifecycle columns.
--
-- entity_facts carries only part of a full fact lifecycle contract so far
-- (043 forgotten_at, 061 consolidated, 062 forgotten_cause). This adds the
-- missing five, all additive + NULLABLE (or NOT NULL with a backfilling
-- DEFAULT), no behavior change for existing rows:
--
--   - visibility        — 'private' (default) | 'world'. The remote-read gate:
--                         a public/scoped reader is limited to world facts at
--                         the read layer; the operator sees all. Every existing
--                         row backfills to 'private' (nothing leaks by default).
--   - superseded_by     — pointer to the fact that replaced this one. Until
--                         now the supersede path only wrote a free-text
--                         forgotten_reason ('superseded by fact N'), so chains
--                         were untraversable by SQL. FK to entity_facts(id).
--   - consolidated_into — pointer to the promoted consolidated take this row
--                         was folded into (mig061 only had the boolean).
--   - context           — optional free-text situational note carried by the
--                         extractor ("said during standup").
--   - source_session    — opaque session id the fact was captured under;
--                         drives the recall session filter.
--
-- Backfill: superseded_by is recoverable for rows retired by the mig062
-- supersede path — the reason text is machine-written ('superseded by fact
-- <id>'), so parse it, guarded on the target row actually existing.

ALTER TABLE entity_facts ADD COLUMN IF NOT EXISTS visibility        TEXT NOT NULL DEFAULT 'private';
ALTER TABLE entity_facts ADD COLUMN IF NOT EXISTS superseded_by     BIGINT;
ALTER TABLE entity_facts ADD COLUMN IF NOT EXISTS consolidated_into BIGINT;
ALTER TABLE entity_facts ADD COLUMN IF NOT EXISTS context           TEXT;
ALTER TABLE entity_facts ADD COLUMN IF NOT EXISTS source_session    TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'entity_facts_visibility_chk'
       AND conrelid = 'entity_facts'::regclass
  ) THEN
    ALTER TABLE entity_facts
      ADD CONSTRAINT entity_facts_visibility_chk
      CHECK (visibility IN ('private', 'world'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'entity_facts_superseded_by_fkey'
       AND conrelid = 'entity_facts'::regclass
  ) THEN
    ALTER TABLE entity_facts
      ADD CONSTRAINT entity_facts_superseded_by_fkey
      FOREIGN KEY (superseded_by) REFERENCES entity_facts(id);
  END IF;
END $$;

-- Recover the supersede pointer from the machine-written reason text. Only
-- rows the dedup/supersede path retired (cause='supersede'), only when the
-- referenced fact still exists (FK safety). Idempotent: touches NULLs only.
UPDATE entity_facts ef
   SET superseded_by = (regexp_match(ef.forgotten_reason, '^superseded by fact (\d+)$'))[1]::bigint
 WHERE ef.superseded_by IS NULL
   AND ef.forgotten_cause = 'supersede'
   AND ef.forgotten_reason ~ '^superseded by fact \d+$'
   AND EXISTS (
     SELECT 1 FROM entity_facts t
      WHERE t.id = (regexp_match(ef.forgotten_reason, '^superseded by fact (\d+)$'))[1]::bigint
   );

-- Session filter path (recall --session): partial — most rows carry no session.
CREATE INDEX IF NOT EXISTS entity_facts_session_idx
  ON entity_facts (source_id, source_session)
  WHERE source_session IS NOT NULL;

-- Supersession audit surface: newest-first scan of retired-with-pointer rows.
CREATE INDEX IF NOT EXISTS entity_facts_superseded_idx
  ON entity_facts (source_id, forgotten_at DESC)
  WHERE superseded_by IS NOT NULL;
