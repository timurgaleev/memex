-- 062_entity_facts_forgotten_cause.sql — structured cause for a tombstone.
--
-- `entity_facts` already carries the tombstone pair from migration 043:
--   - `forgotten_at`     — WHEN the fact was retired (NULL = live).
--   - `forgotten_reason` — free-text audit note (whatever the caller passed).
--
-- Both are cause-agnostic: a by-id `forget_fact` and a future dedup/supersede
-- path would BOTH stamp `forgotten_at`, so `forgotten_at IS NOT NULL` alone
-- cannot tell an operator "forget" from an automatic "supersede". This matters
-- for the fence-reconcile path: if a supersede ever tombstones a fence-sourced
-- claim, a reconcile skip-set built from `forgotten_at` would wrongly suppress
-- that claim's legitimate fence re-insert. The fix is a STRUCTURED discriminator
-- distinct from the free-text reason:
--   - `forgotten_cause` — one of 'forget' | 'supersede' (NULL on legacy rows and
--     on any row retired before this column existed).
--
-- `forget_fact` stamps 'forget'; a supersede/dedup path stamps 'supersede'. A
-- consumer that must not resurrect a genuinely-forgotten fact (e.g. a reconcile
-- skip-set) honors ONLY 'forget', letting a superseded fence claim re-enter from
-- its canonical fence.
--
-- Additive (ADD COLUMN IF NOT EXISTS) + NULLABLE — no backfill, every existing
-- row keeps its current behavior. The CHECK is added inside a catalog-guarded
-- DO block (Postgres has no ADD CONSTRAINT IF NOT EXISTS) so the migration is
-- re-run-safe, and it explicitly allows NULL.

ALTER TABLE entity_facts ADD COLUMN IF NOT EXISTS forgotten_cause TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'entity_facts_forgotten_cause_chk'
       AND conrelid = 'entity_facts'::regclass
  ) THEN
    ALTER TABLE entity_facts
      ADD CONSTRAINT entity_facts_forgotten_cause_chk
      CHECK (forgotten_cause IS NULL OR forgotten_cause IN ('forget', 'supersede'));
  END IF;
END $$;
