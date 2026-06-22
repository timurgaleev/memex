-- 040_document_soft_delete.sql — document-level soft-delete + archive so the
-- search visibility filter can hide retired/quarantined content WITHOUT a hard
-- DELETE (audit trail preserved; restore is a column flip).
--
-- Until now memex only soft-deleted PAGES (migration 015) and relied on the
-- page→search mirror being dropped to take a deleted page out of results.
-- File-indexed `documents` had no soft-delete at all — the only way to retire
-- one was a hard DELETE on the next sweep. This adds the same soft-delete /
-- archive model the page store already has, at the documents level, and a
-- shared search visibility filter (core/visibility.ts) excludes:
--   * deleted_at IS NOT NULL  (soft-deleted, awaiting 72h purge)
--   * archived = true         (source archived, awaiting archive_expires_at)
--   * frontmatter ? 'quarantine'  (high-confidence junk marker; no column)
--
-- All additive + nullable/defaulted: existing rows get deleted_at = NULL,
-- archived = false → they stay fully visible. No behavior change until a
-- caller soft-deletes / archives / quarantines a document.

ALTER TABLE documents ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS archive_expires_at TIMESTAMPTZ;

-- Partial index supports the purge sweep (find expired soft-deletes) without
-- bloating the common deleted_at IS NULL path.
CREATE INDEX IF NOT EXISTS documents_deleted_at_purge_idx
  ON documents (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS documents_archive_expires_idx
  ON documents (archive_expires_at) WHERE archive_expires_at IS NOT NULL;
