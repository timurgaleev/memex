-- 028_chunk_parent_symbol_path_array.sql — widen chunks.parent_symbol_path
-- from scalar TEXT to TEXT[] so nested symbols keep their FULL ancestor
-- chain, not just the innermost parent.
--
-- Migration 027 stored only the innermost enclosing symbol name (scalar):
-- a method inside `outer() { class Inner { … } }` recorded "Inner" and lost
-- "outer". The code chunker now emits the whole chain outermost-first
-- (parent_symbol_path = ['outer','Inner']); this column change lets the row
-- hold it.
--
-- Existing scalar values are cast to a 1-element array in place — no data
-- loss, the innermost parent is preserved. Deeper ancestors fill in on the
-- next reindex of each code file (the indexer overwrites a document's chunks
-- idempotently). Markdown chunks stay NULL.
--
-- Pure schema widen + in-place cast. parent_symbol_path is not yet surfaced
-- in search output, so there is no public/redaction surface change here.
--
-- Idempotency: the migration runner records applied ids and runs each file
-- once inside a single transaction, so the cast is normally a one-shot. The
-- catalog guard below makes it re-run-safe anyway: it only casts while the
-- column is still scalar `text` and no-ops once it is already `text[]`.
-- Without the guard, a second `ARRAY[parent_symbol_path]` cast on an
-- already-array column would nest the value (['outer','Inner'] →
-- [['outer','Inner']]). Surfaced by the codex second-opinion review.

DO $$
DECLARE
  col_type text;
  col_udt  text;
BEGIN
  SELECT data_type, udt_name
    INTO col_type, col_udt
  FROM information_schema.columns
  WHERE table_schema = current_schema()
    AND table_name   = 'chunks'
    AND column_name  = 'parent_symbol_path';

  IF col_type = 'text' THEN
    ALTER TABLE chunks
      ALTER COLUMN parent_symbol_path TYPE TEXT[]
      USING (
        CASE
          WHEN parent_symbol_path IS NULL THEN NULL
          ELSE ARRAY[parent_symbol_path]
        END
      );
  ELSIF col_type = 'ARRAY' AND col_udt = '_text' THEN
    NULL;  -- already TEXT[] — idempotent no-op
  ELSE
    RAISE EXCEPTION
      'chunks.parent_symbol_path has unexpected type %/% (expected text or text[])',
      col_type, col_udt;
  END IF;
END $$;
