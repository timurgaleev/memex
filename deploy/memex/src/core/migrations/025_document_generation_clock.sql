-- 025_document_generation_clock.sql — cache-invalidation clock for the
-- LIVE retrieval model (documents/chunks).
--
-- Migration 022 added a generation clock on `pages`, but the live search
-- path indexes into `documents`/`chunks` (the `pages` model is dormant).
-- This singleton mirrors that clock on the live model: it is bumped on
-- every document write (see core/generation.ts bumpDocumentClock, called
-- from the indexer transaction). A future query cache records the clock
-- value at write time, then a single cheap read tells a reader whether the
-- corpus changed since — making cached results safe to reuse.
--
-- Global counter only (no per-document column): the query cache needs the
-- corpus-level "did anything change" signal, not per-row invalidation.

CREATE TABLE IF NOT EXISTS document_generation_clock (
  id     INTEGER PRIMARY KEY DEFAULT 1,
  value  BIGINT  NOT NULL DEFAULT 0,
  CONSTRAINT document_generation_clock_singleton CHECK (id = 1)
);

INSERT INTO document_generation_clock (id, value)
VALUES (1, 0)
ON CONFLICT (id) DO NOTHING;
