-- 058_chunks_source_id.sql — denormalized per-chunk tenant mirror.
--
-- chunks are scoped transitively today (JOIN documents ON chunks.document_id =
-- documents.id, then filter documents.source_id). This adds a NULLABLE mirror of
-- documents.source_id onto chunks so a future per-chunk scope / targeted re-embed
-- can filter chunks directly without the documents join.
--
-- NULLABLE ON PURPOSE — do NOT default to 'default'. documents.source_id is
-- itself nullable (mig 047 left it managed by the path-prefix classifier in
-- core/sources.ts; a NULL means "unclassified", NOT "the default tenant"). A
-- 'default' fallback here would freeze every NULL-source doc's chunks to the
-- default tenant and mis-scope them — the exact cross-tenant leak the tenancy
-- work exists to prevent. The mirror stays byte-for-byte equal to the parent
-- (including NULL).
--
-- NO foreign key — this is a cheap denormalized copy, and documents already FKs
-- sources(id). Adding an FK here would only duplicate that guarantee.
--
-- SYNC CONTRACT: writeDocumentTransaction (core/indexer-tx.ts) stamps each new
-- chunk with the AUTHORITATIVE post-upsert documents.source_id, keeping the
-- mirror in lock-step on every (re)index. This migration backfills the existing
-- corpus once; the writer maintains it thereafter.
--
-- Additive + idempotent + reversible: ADD COLUMN IF NOT EXISTS is metadata-only
-- on Postgres 11+ / PGLite 17.5, the backfill is a one-shot UPDATE, and dropping
-- the column fully reverts the change. Behavior-neutral until a reader consumes
-- the column.

-- 1. The mirror column — nullable, no default, no FK.
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS source_id TEXT;

-- 2. One-shot backfill from the parent document. IS DISTINCT FROM is NULL-safe,
--    so this only touches rows whose mirror does not already match the parent
--    (idempotent on re-run; a no-op once converged).
UPDATE chunks c
   SET source_id = d.source_id
  FROM documents d
 WHERE c.document_id = d.id
   AND c.source_id IS DISTINCT FROM d.source_id;

-- 3. Partial index for scoped lookups — skips the NULL (unclassified) rows the
--    fail-closed scoped reads exclude anyway, keeping the index small.
CREATE INDEX IF NOT EXISTS idx_chunks_source_id ON chunks(source_id) WHERE source_id IS NOT NULL;
