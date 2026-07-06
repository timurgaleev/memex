-- 076: restore the atom provenance fields the reference extracts.
--
-- The reference's atom extractor captures a verbatim `source_quote` (<=200
-- chars, the exact line the atom was distilled from) and a one-sentence
-- `lesson` alongside title/body. memex's port dropped both; this adds the
-- columns so extract-atoms can persist them (and surface them on the atom's
-- page mirror). Nullable — pre-076 atoms simply predate the fields.
--
-- Additive + idempotent: ADD COLUMN IF NOT EXISTS only.

ALTER TABLE synth_atoms
  ADD COLUMN IF NOT EXISTS source_quote TEXT;

ALTER TABLE synth_atoms
  ADD COLUMN IF NOT EXISTS lesson TEXT;
