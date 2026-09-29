-- memex schema migration 014: code chunkers — graph-only call/def/ref index.
--
-- Two changes here:
--
-- 1. Widen entities.type CHECK so the four code-* entity types we
--    extract from tree-sitter parses can be stored alongside the
--    existing wikilink / tag / date set:
--      code-def     — definition site for a name (function, class, …)
--      code-ref     — non-defining identifier reference
--      code-caller  — symbol whose body issues a call to <name>
--      code-callee  — symbol called from inside <enclosing>
--
-- 2. Record line ranges on chunks so `code-callees src/foo.ts:42` can
--    resolve "which symbol covers line 42 of foo.ts" via SQL. Markdown
--    chunks leave both columns NULL (no per-chunk line ranges today),
--    code chunks populate both.

ALTER TABLE entities DROP CONSTRAINT IF EXISTS entities_type_check;
ALTER TABLE entities DROP CONSTRAINT IF EXISTS entities_check;
ALTER TABLE entities
  ADD CONSTRAINT entities_type_check
    CHECK (type IN (
      'wikilink',
      'tag',
      'date',
      'code-def',
      'code-ref',
      'code-caller',
      'code-callee'
    ));

ALTER TABLE chunks
  ADD COLUMN IF NOT EXISTS start_line INTEGER,
  ADD COLUMN IF NOT EXISTS end_line   INTEGER;

-- Composite index for `code-callees <path>:<line>` line-range lookup.
-- The query shape is:
--   SELECT id FROM chunks
--   WHERE document_id = $1 AND $2 BETWEEN start_line AND end_line
-- Postgres can use the composite to filter by document_id and then
-- range-scan the line columns.
CREATE INDEX IF NOT EXISTS chunks_doc_line_idx
  ON chunks(document_id, start_line, end_line);
