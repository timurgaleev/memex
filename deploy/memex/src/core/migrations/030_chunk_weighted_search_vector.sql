-- 030_chunk_weighted_search_vector.sql — weighted chunk FTS.
--
-- The existing `ts` column (migration 001) is to_tsvector('simple', content)
-- with every lexeme at the default weight 'D'. This adds a parallel
-- `search_vector` that ranks a chunk's SYMBOL IDENTITY (symbol_name +
-- parent_symbol_path, populated for code chunks by migrations 027/028) at
-- weight 'A' above its body text at weight 'B', so a query that names a
-- function/class — or its enclosing scope — ranks that symbol's chunk above
-- chunks that only mention the term in prose.
--
-- Markdown chunks have NULL symbol columns, so their 'A' segment is empty and
-- every lexeme lands at weight 'B' — a uniform shift from 'D' that scales
-- ts_rank_cd identically across all markdown rows, leaving their relative
-- order (and thus the rank-based RRF contribution) unchanged. Only chunks
-- carrying symbol metadata gain the differential boost.
--
-- For CODE chunks this is also a small RECALL change, not only a re-ranking:
-- a query naming an enclosing scope now matches a nested chunk whose body text
-- never mentions it (the scope token lives only in parent_symbol_path, in the
-- 'A' segment). That is the intended qualified-symbol boost. Markdown recall
-- is unchanged (its matched set is a strict superset of `ts` only in that the
-- empty 'A' segment adds no lexemes).
--
-- Adapted from the reference's weighted chunk FTS, which weights
-- doc_comment + symbol_name_qualified at 'A'. memex has neither column yet
-- (separate backlog items); its equivalent symbol identity is
-- symbol_name + parent_symbol_path. When doc_comment lands, fold it into the
-- 'A' segment of the function below.
--
-- Mechanism: a BEFORE trigger, matching the reference (NOT a STORED GENERATED
-- column like the existing `ts`). A generated column's expression must be
-- IMMUTABLE, and `array_to_string(parent_symbol_path, ' ')` — needed to fold
-- the array scope into the tsvector with 'simple' normalization so it matches
-- a lowercased plainto_tsquery — is not immutable on the engines we run. A
-- trigger has no such constraint. memex's indexer wipes and re-INSERTs a
-- document's chunks on every write (indexer-tx.ts: DELETE then INSERT), so a
-- BEFORE INSERT trigger always recomputes from fresh column values; the
-- `UPDATE OF` clause additionally covers any future in-place column update.
--
-- Config stays 'simple' (not the reference's 'english') to match the existing
-- `ts` tokenization exactly: the keyword read path still uses
-- plainto_tsquery('simple', …), so the matched SET is identical for markdown
-- chunks and only the rank weighting changes. Switching to 'english' would
-- change stemming/stopwords and alter recall — out of scope here.
--
-- `ts` is left in place (other diagnostics may reference it and dropping a
-- generated column forces an extra table rewrite); only the keyword arm
-- switches to search_vector.

ALTER TABLE chunks ADD COLUMN IF NOT EXISTS search_vector tsvector;

CREATE OR REPLACE FUNCTION chunks_update_search_vector() RETURNS trigger AS $fn$
BEGIN
  NEW.search_vector :=
    setweight(
      to_tsvector(
        'simple',
        COALESCE(NEW.symbol_name, '') || ' ' ||
        COALESCE(array_to_string(NEW.parent_symbol_path, ' '), '')
      ),
      'A'
    ) ||
    setweight(to_tsvector('simple', COALESCE(NEW.content, '')), 'B');
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS chunks_search_vector_trigger ON chunks;
CREATE TRIGGER chunks_search_vector_trigger
  BEFORE INSERT OR UPDATE OF content, symbol_name, parent_symbol_path
  ON chunks
  FOR EACH ROW EXECUTE FUNCTION chunks_update_search_vector();

-- Backfill existing rows — the trigger only fires on future writes. The same
-- expression as the function (array_to_string is fine in a plain UPDATE);
-- idempotent (recomputes the identical value on re-run).
UPDATE chunks SET search_vector =
    setweight(
      to_tsvector(
        'simple',
        COALESCE(symbol_name, '') || ' ' ||
        COALESCE(array_to_string(parent_symbol_path, ' '), '')
      ),
      'A'
    ) ||
    setweight(to_tsvector('simple', COALESCE(content, '')), 'B');

CREATE INDEX IF NOT EXISTS chunks_search_vector_idx
  ON chunks USING GIN(search_vector);
