-- 054_documents_entities_extracted_at.sql — entity-extraction freshness
-- watermark (the memex-native equivalent of the reference's incremental
-- extract, which threads sync's changed-slug list into extract).
--
-- Adds a per-document timestamp recording when the doc's entity_mentions were
-- last (re)extracted. A document is STALE for entity extraction when:
--   entities_extracted_at IS NULL                        (never extracted)
--   OR entities_extracted_at < ENTITY_EXTRACTOR_VERSION_TS (extractor bumped)
--   OR updated_at > entities_extracted_at                (re-indexed since)
-- See src/core/extract.ts (ENTITY_EXTRACTOR_VERSION_TS + the gated query). The
-- cycle's extract phase runs incremental by default — it no longer re-walks the
-- whole corpus every tick (the 1.4 GB / 30 s heavy phase).
--
-- GRANDFATHER: no backfill. Every existing doc gets NULL, so the first run after
-- this migration does one final FULL walk (NULL is stale), stamps each doc, then
-- every later run only touches changed docs.
--
-- PGLite-safe: ADD COLUMN with no DEFAULT (NULL) is metadata-only; plain CREATE
-- INDEX (no CONCURRENTLY — migrations apply on boot in one connection). The
-- selection query filters `deleted_at IS NULL` (documents got soft-delete in
-- migration 040) so a soft-deleted doc isn't re-extracted over its surviving
-- chunks.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS entities_extracted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_documents_entities_extracted_at
  ON documents(entities_extracted_at);
