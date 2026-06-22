-- 041_code_edges.sql — chunk-to-chunk code call graph with deferred resolution.
--
-- memex already extracts call edges as entity rows (code-caller/code-callee,
-- bare name) which power `code-callers`/`code-callees`. That index aliases
-- same-named methods across classes together. This adds a typed edge table
-- whose targets are resolved to a SPECIFIC defining chunk by the
-- `resolve-symbol-edges` cycle phase, disambiguating within a document.
--
-- Design mirrors the reference: one unresolved table; resolution writes the
-- defining chunk id into edge_metadata.resolved_chunk_id (or marks ambiguous),
-- rather than promoting rows between tables.

-- Qualified symbol name (parent_symbol_path :: symbol_name) for code chunks —
-- the key resolution matches against. Backfilled from the existing columns.
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS symbol_name_qualified TEXT;

-- Watermark so the resolution phase only re-walks chunks it hasn't resolved at
-- the current extractor version (NULL = never resolved).
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS edges_backfilled_at TIMESTAMPTZ;

-- Backfill qualified names for existing code chunks (symbol_name present).
-- parent_symbol_path is TEXT[] (NULL at top level) → prefix when present.
UPDATE chunks
   SET symbol_name_qualified = CASE
         WHEN parent_symbol_path IS NULL OR cardinality(parent_symbol_path) = 0
           THEN symbol_name
         ELSE array_to_string(parent_symbol_path, '::') || '::' || symbol_name
       END
 WHERE symbol_name IS NOT NULL AND symbol_name_qualified IS NULL;

CREATE INDEX IF NOT EXISTS chunks_symbol_qualified_idx
  ON chunks (symbol_name_qualified) WHERE symbol_name_qualified IS NOT NULL;

CREATE INDEX IF NOT EXISTS chunks_edges_backfill_idx
  ON chunks (edges_backfilled_at);

-- Unresolved code edges. `to_chunk_id` is filled by the resolution phase into
-- edge_metadata.resolved_chunk_id (JSONB) — no row promotion, no typed
-- to_chunk_id column (faithful to the reference).
CREATE TABLE IF NOT EXISTS code_edges_symbol (
  id                    SERIAL PRIMARY KEY,
  from_chunk_id         TEXT NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  from_symbol_qualified TEXT,
  to_symbol_qualified   TEXT NOT NULL,
  edge_type             TEXT NOT NULL,
  edge_metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_id             TEXT REFERENCES sources(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (from_chunk_id, to_symbol_qualified, edge_type)
);

CREATE INDEX IF NOT EXISTS code_edges_symbol_from_idx
  ON code_edges_symbol (from_chunk_id);
CREATE INDEX IF NOT EXISTS code_edges_symbol_to_idx
  ON code_edges_symbol (to_symbol_qualified);
