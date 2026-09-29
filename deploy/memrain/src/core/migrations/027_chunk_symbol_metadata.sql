-- 027_chunk_symbol_metadata.sql — per-chunk code-symbol metadata on the
-- LIVE retrieval model (documents/chunks).
--
-- The code chunker (core/chunkers/code.ts) already parses one chunk per
-- top-level symbol and computes its name, kind, enclosing symbol, and the
-- file language — but only the line range (start_line/end_line, migration
-- 014) was persisted. These columns capture the rest so retrieval can
-- return symbol-level context ("function `foo.bar` (method) in src/x.ts")
-- and `code-callees <path>:<line>` can name the covering symbol straight
-- from the chunk row instead of cross-referencing the entity graph.
--
-- All nullable: markdown chunks leave every column NULL (no symbols), code
-- chunks populate them. Pure additive DDL — no behavioral change until the
-- indexer (indexer-code.ts / indexer-tx.ts) writes the values; the public
-- search output is unchanged, so no redaction surface changes here.
--   symbol_name        — bare identifier (e.g. `handleHealth`)
--   symbol_type        — kind: function | class | method | arrow | const | module-import
--   parent_symbol_path — innermost enclosing symbol name, NULL at top level
--   language           — detected source language (typescript | python | …)

ALTER TABLE chunks
  ADD COLUMN IF NOT EXISTS symbol_name        TEXT,
  ADD COLUMN IF NOT EXISTS symbol_type        TEXT,
  ADD COLUMN IF NOT EXISTS parent_symbol_path TEXT,
  ADD COLUMN IF NOT EXISTS language           TEXT;

-- Partial index for symbol-name lookup (`code chunks only`). The query
-- shape is `SELECT … FROM chunks WHERE symbol_name = $1`; markdown chunks
-- (symbol_name IS NULL) are excluded to keep the index small.
CREATE INDEX IF NOT EXISTS chunks_symbol_name_idx
  ON chunks(symbol_name)
  WHERE symbol_name IS NOT NULL;
