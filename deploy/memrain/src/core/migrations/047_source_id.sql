-- 047_source_id.sql — per-tenant data partitioning (the `source_id` axis).
--
-- Makes every content row carry the source (tenant) that owns it, so a
-- source-scoped caller never reads another tenant's data. See docs/tenancy.md.
--
-- Safety / scope of THIS migration:
--   * Additive columns only, each NOT NULL DEFAULT 'default' so existing rows
--     backfill atomically to the single legacy tenant — a single-holder brain
--     keeps working unchanged (one tenant named 'default').
--   * `documents.source_id` already exists (migration 004, nullable): backfill
--     its NULLs to 'default', then make it the same NOT NULL DEFAULT.
--   * pages keep `slug` as PK (incremental path) and gain UNIQUE(source_id,
--     slug); the composite PK is a later, separately-tested step.
--   * Row-Level-Security backstop is intentionally NOT enabled here — it
--     requires a per-connection `SET app.current_sources` in the pool, and
--     enabling RLS without that setter would lock the brain out. RLS lands in a
--     dedicated migration alongside the pool plumbing. App-layer filtering is
--     the primary isolation in this slice.

-- 1. Tenant registry: ensure the legacy 'default' source exists as the FK
--    target for every backfilled row. kind='other' keeps it out of the
--    path-prefix backfill in core/sources.ts; a dedicated 'tenant' kind arrives
--    with per-user provisioning.
INSERT INTO sources (id, kind, path_prefix)
VALUES ('default', 'other', '__default__')
ON CONFLICT (id) DO NOTHING;

-- 2. documents — column already exists from mig 004 (nullable) and is managed
--    by the path-prefix classifier in core/sources.ts (backfillDocumentSources
--    assigns vault/memory/… sources to NULL rows at boot). Leave it nullable
--    and untouched: forcing NOT NULL DEFAULT 'default' here would pre-empt that
--    classifier (a doc that should map to 'vault' would be frozen as 'default').
--    Tenant writes stamp an explicit source_id at index time (indexer); scoped
--    reads use `source_id = ANY($allowed)`, which excludes NULL rows
--    fail-closed (a remote tenant never sees an unclassified legacy doc).

-- 3. pages — the canonical store. Keep slug PK; add the tenancy column + the
--    (source_id, slug) uniqueness that the composite PK will later formalize.
ALTER TABLE pages
  ADD COLUMN IF NOT EXISTS source_id TEXT NOT NULL DEFAULT 'default'
    REFERENCES sources(id);
CREATE UNIQUE INDEX IF NOT EXISTS pages_source_slug_key ON pages (source_id, slug);
CREATE INDEX IF NOT EXISTS idx_pages_source_id ON pages (source_id);

ALTER TABLE page_versions
  ADD COLUMN IF NOT EXISTS source_id TEXT NOT NULL DEFAULT 'default';

-- 4. links — graph edges. Direct link-table reads (graph traversal,
--    listLinkSources) scope on this column.
ALTER TABLE links
  ADD COLUMN IF NOT EXISTS source_id TEXT NOT NULL DEFAULT 'default'
    REFERENCES sources(id);
CREATE INDEX IF NOT EXISTS idx_links_source_id ON links (source_id);

-- 5. entity_facts
ALTER TABLE entity_facts
  ADD COLUMN IF NOT EXISTS source_id TEXT NOT NULL DEFAULT 'default'
    REFERENCES sources(id);
CREATE INDEX IF NOT EXISTS idx_entity_facts_source_id ON entity_facts (source_id);

-- 6. timeline_events
ALTER TABLE timeline_events
  ADD COLUMN IF NOT EXISTS source_id TEXT NOT NULL DEFAULT 'default'
    REFERENCES sources(id);
CREATE INDEX IF NOT EXISTS idx_timeline_events_source_id ON timeline_events (source_id);

-- 7. tags
ALTER TABLE tags
  ADD COLUMN IF NOT EXISTS source_id TEXT NOT NULL DEFAULT 'default'
    REFERENCES sources(id);
CREATE INDEX IF NOT EXISTS idx_tags_source_id ON tags (source_id);
