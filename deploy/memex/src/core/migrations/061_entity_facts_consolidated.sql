-- 061_entity_facts_consolidated.sql — consolidation marker for facts.
--
-- The deterministic `consolidate` cycle phase (core/cycle/consolidate-facts.ts)
-- clusters an entity's unconsolidated facts by embedding cosine and promotes a
-- cluster of >= 2 into a single consolidated "take" fact (written_by
-- 'facts-consolidate'). It NEVER deletes a contributing fact — it marks it
-- `consolidated = true` so it stays in the ledger for audit but is excluded from
-- future consolidation passes. The promoted take is itself written with
-- `consolidated = true` so it is never re-clustered.
--
--   - `consolidated`    — true once a fact has been folded into a take (or is a
--                         promoted take). Default false: every existing row is
--                         unconsolidated, unchanged.
--   - `consolidated_at` — when the marker was set (audit; NULL while false).
--
-- Both are additive (ADD COLUMN IF NOT EXISTS). `consolidated` is NOT NULL with
-- a DEFAULT so the phase's `WHERE consolidated = false` predicate never has to
-- reason about NULL; the DEFAULT backfills existing rows to false at migrate
-- time (a cheap metadata-only default on modern Postgres).
--
-- Partial index on the unconsolidated, live, embedded candidate set the phase
-- scans each run — keeps the per-(source_id, entity_slug) bucket query cheap as
-- consolidated rows accumulate.

ALTER TABLE entity_facts ADD COLUMN IF NOT EXISTS consolidated    BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE entity_facts ADD COLUMN IF NOT EXISTS consolidated_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS entity_facts_unconsolidated_idx
  ON entity_facts (source_id, entity_slug)
  WHERE consolidated = false AND forgotten_at IS NULL AND embedding IS NOT NULL;
