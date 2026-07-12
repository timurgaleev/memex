-- 032_chunk_doc_comment.sql — capture a code chunk's doc comment and fold it
-- into the weighted FTS at weight 'A'.
--
-- Migration 030 added `chunks.search_vector` weighting symbol identity
-- (symbol_name + parent_symbol_path) at 'A' and body at 'B', and left a note:
-- "When doc_comment lands, fold it into the 'A' segment of the function." This
-- does exactly that. `doc_comment` is the JSDoc/`//` block above a JS/TS symbol
-- or a Python docstring, extracted by the code chunker (core/chunkers/code.ts)
-- and written by indexer-tx. Weighting it 'A' lets a query that uses a
-- function's DOC vocabulary — not its identifier — rank that function's chunk
-- above chunks that only mention the term incidentally in prose.
--
-- NULL-safe and markdown-safe: markdown chunks and code symbols without a doc
-- comment leave `doc_comment` NULL, so `COALESCE(...,'')` contributes an empty
-- 'A' segment — the markdown matched set + relative order (and thus the
-- rank-based RRF contribution) are unchanged, exactly as in migration 030.
--
-- Config stays 'simple' to match the existing keyword read path
-- (plainto_tsquery('simple', …)) — so the matched SET for markdown is
-- identical and only code-chunk weighting changes. (memex deliberately keeps
-- 'simple' for consistent tokenization with migrations 001/030 — switching
-- stemming/stopwords is a separate recall change, out of scope here.)
--
-- Mechanism mirrors 030: a BEFORE trigger (not a generated column —
-- array_to_string over parent_symbol_path is not IMMUTABLE). CREATE OR REPLACE
-- on the same function name + recreate the trigger so it also fires on an
-- in-place `doc_comment` update; then backfill existing rows. Idempotent.

ALTER TABLE chunks ADD COLUMN IF NOT EXISTS doc_comment TEXT;

CREATE OR REPLACE FUNCTION chunks_update_search_vector() RETURNS trigger AS $fn$
BEGIN
  NEW.search_vector :=
    setweight(
      to_tsvector(
        'simple',
        COALESCE(NEW.symbol_name, '') || ' ' ||
        COALESCE(array_to_string(NEW.parent_symbol_path, ' '), '') || ' ' ||
        COALESCE(NEW.doc_comment, '')
      ),
      'A'
    ) ||
    setweight(to_tsvector('simple', COALESCE(NEW.content, '')), 'B');
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS chunks_search_vector_trigger ON chunks;
CREATE TRIGGER chunks_search_vector_trigger
  BEFORE INSERT OR UPDATE OF content, symbol_name, parent_symbol_path, doc_comment
  ON chunks
  FOR EACH ROW EXECUTE FUNCTION chunks_update_search_vector();

-- Backfill existing rows — the trigger only fires on future writes. Same
-- expression as the function (array_to_string is fine in a plain UPDATE);
-- idempotent (recomputes the identical value on re-run). Existing code chunks
-- have doc_comment NULL until reindexed, so this is a no-op on their vector
-- today; the differential boost arrives when they are next reindexed.
UPDATE chunks SET search_vector =
    setweight(
      to_tsvector(
        'simple',
        COALESCE(symbol_name, '') || ' ' ||
        COALESCE(array_to_string(parent_symbol_path, ' '), '') || ' ' ||
        COALESCE(doc_comment, '')
      ),
      'A'
    ) ||
    setweight(to_tsvector('simple', COALESCE(content, '')), 'B');
