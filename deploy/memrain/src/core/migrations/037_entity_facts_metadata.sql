-- 037_entity_facts_metadata.sql — fact metadata columns.
--
-- Extends entity_facts with four NULLABLE metadata fields carried by the
-- `## Facts` fence (core/facts-fence.ts) and projected by the reconcile pass
-- (core/facts-reconcile.ts):
--   - `kind`        — fact category (event / preference / commitment / belief /
--                     fact). Categorizes a claim.
--   - `notability`  — importance ordinal (high / medium / low). Feeds recall
--                     ranking (a high-notability fact outranks a low one).
--   - `valid_from`  — ISO date the fact became true.
--   - `valid_until` — ISO date the fact stopped being true (a forget/supersede
--                     marker; a fact with a past valid_until is historical).
--
-- All four are additive (ADD COLUMN IF NOT EXISTS) and NULLABLE — no data
-- rewrite, no backfill, and every existing row (and every legacy 4-column
-- fence) keeps its current behavior with NULL metadata. The fence parser
-- normalizes a hand-edited cell to NULL when it isn't a recognized enum value /
-- valid ISO date, so the DB never sees a poisoned value; the CHECK constraints
-- below are defense-in-depth against a direct writer, and explicitly allow
-- NULL.
--
-- CHECK constraints are added inside catalog-guarded DO blocks so the migration
-- is re-run-safe (Postgres has no ADD CONSTRAINT IF NOT EXISTS). There is
-- deliberately NO `valid_until >= valid_from` CHECK: the fence is hand-editable
-- and must degrade gracefully — an inverted interval is stored as-is rather
-- than aborting a whole page's reconcile. A recall consumer that assumes
-- ordering must tolerate (or skip) inverted rows itself.

ALTER TABLE entity_facts ADD COLUMN IF NOT EXISTS kind        TEXT;
ALTER TABLE entity_facts ADD COLUMN IF NOT EXISTS notability  TEXT;
ALTER TABLE entity_facts ADD COLUMN IF NOT EXISTS valid_from  DATE;
ALTER TABLE entity_facts ADD COLUMN IF NOT EXISTS valid_until DATE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'entity_facts_kind_chk'
       AND conrelid = 'entity_facts'::regclass
  ) THEN
    ALTER TABLE entity_facts
      ADD CONSTRAINT entity_facts_kind_chk
      CHECK (kind IS NULL OR kind IN
        ('event', 'preference', 'commitment', 'belief', 'fact'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'entity_facts_notability_chk'
       AND conrelid = 'entity_facts'::regclass
  ) THEN
    ALTER TABLE entity_facts
      ADD CONSTRAINT entity_facts_notability_chk
      CHECK (notability IS NULL OR notability IN ('high', 'medium', 'low'));
  END IF;
END $$;
