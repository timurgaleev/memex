-- memex schema migration 002: entity graph + sweep tracking.
--
-- Adds two new tables:
--   * entities         — distinct named things (wikilinks, tags, dates) that
--                        appear in any document. Type-tagged so the recipe
--                        layer can reason about them.
--   * entity_mentions  — N:M between chunks and entities. One row per
--                        (chunk, entity) pair, with the surface form as
--                        observed in the chunk so we can later show context
--                        snippets on entity pages.
--
-- And one column on `documents`:
--   * last_indexed_mtime — ms since epoch of the source file's mtime when
--                          the document was last indexed. The sweep
--                          compares this with the on-disk mtime to decide
--                          whether to re-ingest.

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS last_indexed_mtime BIGINT;

CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('wikilink', 'tag', 'date')),
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (type, name)
);

CREATE INDEX IF NOT EXISTS entities_name_idx ON entities(name);

CREATE TABLE IF NOT EXISTS entity_mentions (
  chunk_id  TEXT NOT NULL REFERENCES chunks(id)   ON DELETE CASCADE,
  entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  surface_form TEXT NOT NULL,
  PRIMARY KEY (chunk_id, entity_id)
);

CREATE INDEX IF NOT EXISTS entity_mentions_entity_idx
  ON entity_mentions(entity_id);
