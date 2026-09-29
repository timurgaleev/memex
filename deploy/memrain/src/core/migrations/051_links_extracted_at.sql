-- 051_links_extracted_at.sql — link-extraction freshness watermark.
--
-- Adds a per-page timestamp recording when the page's link edges
-- (wikilinks + gazetteer mentions + typed-NER) were last (re)extracted.
-- A page is STALE for extraction when:
--   links_extracted_at IS NULL                       (never extracted)
--   OR links_extracted_at < LINK_EXTRACTOR_VERSION_TS (extractor logic bumped)
--   OR updated_at > links_extracted_at               (edited since last extract)
-- See src/core/links.ts (LINK_EXTRACTOR_VERSION_TS, countStalePagesForExtraction,
-- stampLinksExtracted) and the doctor `links_extraction_lag` check.
--
-- GRANDFATHER: no backfill. Every existing page gets NULL here, so the first
-- doctor run surfaces the real historical backlog (the whole point); the check
-- is warn-only and never fails a pipeline.
--
-- PGLite-safe: ADD COLUMN with no DEFAULT (NULL) is metadata-only; plain
-- CREATE INDEX (no CONCURRENTLY — memex applies migrations on boot in a single
-- connection). The composite (source_id, links_extracted_at) backs the
-- source-scoped staleness scans.
ALTER TABLE pages ADD COLUMN IF NOT EXISTS links_extracted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_pages_links_extracted_at
  ON pages(source_id, links_extracted_at);
