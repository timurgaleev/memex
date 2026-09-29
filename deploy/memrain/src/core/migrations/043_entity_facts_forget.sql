-- 043_entity_facts_forget.sql — soft-delete (tombstone) columns for facts.
--
-- Adds the by-id forget marker consumed by core/facts-recall.ts. A fact is
-- never physically deleted: `forget_fact` stamps `forgotten_at` (and an
-- optional `forgotten_reason`) so the row stays for audit, exactly like a
-- soft-deleted page keeps its row + version chain. `recall` filters
-- `forgotten_at IS NULL`. Both columns are additive (ADD COLUMN IF NOT EXISTS)
-- and NULLABLE — a NULL `forgotten_at` is a live fact, so every existing row
-- keeps its current behavior with no backfill; the append-only write path
-- never touches these columns.

ALTER TABLE entity_facts ADD COLUMN IF NOT EXISTS forgotten_at     TIMESTAMPTZ;
ALTER TABLE entity_facts ADD COLUMN IF NOT EXISTS forgotten_reason TEXT;

-- Partial index so the live-fact path (recall / reads filtering on the
-- tombstone) stays cheap as forgotten rows accumulate.
CREATE INDEX IF NOT EXISTS entity_facts_live_idx
  ON entity_facts (id)
  WHERE forgotten_at IS NULL;
