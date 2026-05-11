-- memex schema migration 004: sources as first-class.
--
-- A `source` is a cluster of documents with shared semantics — Obsidian
-- vault, openclaw memory, a webhook stream, etc. Each source declares
-- its sync policy (does Obsidian Sync round-trip the file?) and indexed
-- policy (should the chunk content be retained verbatim, or only its
-- hash?). Search can boost / filter per source.
--
-- Backfill: every existing document gets a default source assignment by
-- path prefix (handled in src/core/sources.ts at boot, NOT here — keeps
-- the migration cheap + DBMS-portable).

CREATE TABLE IF NOT EXISTS sources (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL,
  path_prefix     TEXT NOT NULL,
  sync_policy     TEXT NOT NULL DEFAULT 'synced',
  indexed_policy  TEXT NOT NULL DEFAULT 'verbatim',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (kind IN ('vault', 'memory', 'webhook', 'mailbox', 'calendar', 'transcript', 'other')),
  CHECK (sync_policy IN ('synced', 'local-only', 'mirror')),
  CHECK (indexed_policy IN ('verbatim', 'hashed-only', 'tombstoned'))
);

CREATE UNIQUE INDEX IF NOT EXISTS sources_path_prefix_idx
  ON sources(path_prefix);

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS source_id TEXT REFERENCES sources(id);

CREATE INDEX IF NOT EXISTS documents_source_idx ON documents(source_id);
