-- 097_entity_facts_ontology.sql — per-entity dimensional claims.
--
-- A "dimension" is a named axis a claim is about (e.g. role, employer,
-- location): entity_slug=people/alice, dimension='employer', value='Acme'.
-- These ride entity_facts rather than a new table so the existing bi-temporal
-- machinery (valid_from / valid_until, mig 037) and the lifecycle columns
-- (forgotten_at, superseded_by, …) apply unchanged — a dimensional claim is
-- just a fact with an ontology tag.
--
--   - dimension  — the axis name; NULL for a plain (non-dimensional) fact.
--   - value      — the current value on that axis.
--   - value_hash — content address of the value, for idempotent dedup.
--   - dim_status — optional lifecycle marker for the dimensional projection.
--
-- All additive + NULLABLE: every existing fact keeps dimension NULL and stays
-- out of both partial indexes below.

ALTER TABLE entity_facts ADD COLUMN IF NOT EXISTS dimension  TEXT;
ALTER TABLE entity_facts ADD COLUMN IF NOT EXISTS value      TEXT;
ALTER TABLE entity_facts ADD COLUMN IF NOT EXISTS value_hash TEXT;
ALTER TABLE entity_facts ADD COLUMN IF NOT EXISTS dim_status TEXT;

-- Read path: the live claim on an axis, newest-valid first. Leads with
-- source_id so a scoped reader never scans another tenant's rows.
CREATE INDEX IF NOT EXISTS entity_facts_dimension_idx
  ON entity_facts (source_id, entity_slug, dimension, valid_from DESC)
  WHERE forgotten_at IS NULL AND dimension IS NOT NULL;

-- Content-addressed dedup key: one row per identical dimensional claim from the
-- same source page. Leads with source_id for tenant isolation. source_slug is
-- NULLABLE (a manually-entered claim carries no source page); NULLS NOT
-- DISTINCT makes two NULL-source claims with the same content collapse to one
-- row too, so a retried extraction is idempotent whether or not it names a
-- source. (PG15+ / PGLite PG16 support the clause — verified under bun test.)
--
-- Scoped to OPEN rows only (valid_until IS NULL AND forgotten_at IS NULL): a
-- value must be free to recur after it was retired. For a dimension like role
-- A -> B -> A, the closed historical A row must not block a new open A claim;
-- excluding retired rows from the key keeps bi-temporal history intact while
-- still collapsing duplicate LIVE claims.
CREATE UNIQUE INDEX IF NOT EXISTS entity_facts_dimension_dedup_key
  ON entity_facts (source_id, entity_slug, dimension, value_hash, source_slug)
  NULLS NOT DISTINCT
  WHERE dimension IS NOT NULL AND valid_until IS NULL AND forgotten_at IS NULL;

-- Widen the tombstone-cause discriminator (mig 062) to admit 'consolidate'.
-- Corroboration retires a duplicate observation as an already-forgotten row that
-- records the same value seen from a DIFFERENT source and points
-- consolidated_into the surviving claim. forgotten_at + consolidated_into
-- already retire and link it; 'consolidate' is the structured cause that keeps
-- it distinguishable from an operator 'forget' or an automatic 'supersede'.
--
-- 062's CHECK is a shipped, frozen constraint, so this recreates it in place
-- rather than editing that migration. Guarded on the live definition already
-- naming 'consolidate' so a re-run is a no-op (no needless drop/recreate churn).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'entity_facts_forgotten_cause_chk'
       AND conrelid = 'entity_facts'::regclass
       AND pg_get_constraintdef(oid) LIKE '%consolidate%'
  ) THEN
    ALTER TABLE entity_facts DROP CONSTRAINT IF EXISTS entity_facts_forgotten_cause_chk;
    ALTER TABLE entity_facts
      ADD CONSTRAINT entity_facts_forgotten_cause_chk
      CHECK (forgotten_cause IS NULL
             OR forgotten_cause IN ('forget', 'supersede', 'consolidate'));
  END IF;
END $$;
