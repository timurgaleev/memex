-- 015_pages.sql — DB-canonical page store.
--
-- Pages are the atomic unit of memory in the new model: every captured
-- idea, journal entry, person, company, meeting note, or imported email
-- is a row in `pages`. The body lives in the column (`markdown_body`);
-- there is no filesystem-backed mirror.
--
-- `compiled_truth` is the per-page jsonb header — analogous to a
-- frontmatter block in a markdown file. It holds the agent's current
-- understanding of the entity (tags, links to related slugs, tier,
-- enriched_at, etc.). Editable.
--
-- `page_versions` is the append-only edit history. Every write to
-- `pages` that changes `content_hash` writes a corresponding row here.
-- Caller can recover any prior snapshot. Cascade on delete so a hard
-- DELETE of a page also drops its history (use soft-delete via
-- `deleted_at` to preserve audit trail).
--
-- Slug format: kebab-case with optional `/` namespaces. Enforced at
-- the application layer (core/pages.ts validateSlug). Examples:
--   journal/2026/05/2026-05-18
--   people/alice
--   ideas/inbox/post-canonical-store-redesign
--
-- Types are deliberately NOT a CHECK constraint — the application
-- layer maintains a known list but new types must be addable without
-- a schema migration. Catalogue of well-known types lives in
-- core/pages.ts KNOWN_PAGE_TYPES.

CREATE TABLE IF NOT EXISTS pages (
  slug              TEXT PRIMARY KEY,
  type              TEXT NOT NULL,
  title             TEXT,
  compiled_truth    JSONB NOT NULL DEFAULT '{}'::jsonb,
  markdown_body     TEXT NOT NULL DEFAULT '',
  content_hash      TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS pages_type_idx
  ON pages(type)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS pages_updated_desc_idx
  ON pages(updated_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS pages_compiled_truth_gin_idx
  ON pages USING GIN (compiled_truth);

CREATE TABLE IF NOT EXISTS page_versions (
  slug                     TEXT NOT NULL,
  version_n                INTEGER NOT NULL,
  hash_prev                TEXT,
  hash_new                 TEXT NOT NULL,
  body_snapshot            TEXT NOT NULL,
  compiled_truth_snapshot  JSONB NOT NULL,
  written_by               TEXT,
  written_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (slug, version_n),
  FOREIGN KEY (slug) REFERENCES pages(slug) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS page_versions_slug_time_idx
  ON page_versions(slug, written_at DESC);
