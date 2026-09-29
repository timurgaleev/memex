-- 016_links_typed.sql — page-to-page typed relationships.
--
-- The existing `entities` + `entity_mentions` tables (from 002) are
-- chunk-scoped and serve text-search needs ("find chunks mentioning
-- Alice"). This new `links` table is page-scoped and typed
-- ("Alice works at Acme"; "Meeting M attended by Alice"; "Page A
-- references Page B via wikilink").
--
-- Targets are SOFT references (plain text slugs, no FK). A target page
-- may or may not exist when the link is recorded. A future
-- consolidate-pass turns dangling targets into auto-stub pages OR
-- leaves them as evidence of an unresolved reference. Either way the
-- link row stays valid.
--
-- Sources are HARD references (FK with ON DELETE CASCADE). A link
-- without a source page is meaningless; deleting a page should drop
-- all its outbound links.
--
-- Type vocabulary (application-layer enforcement in core/links.ts
-- KNOWN_LINK_TYPES — extensible without a schema migration):
--   wikilink     — bare [[name]] reference in the body
--   mentions     — generic "page A talks about page B"
--   works_at     — person → company employment
--   attended     — person → meeting/event attendance
--   founded      — person → company founding
--   advises      — person → company advisory
--   invested_in  — person/firm → company investment
--   knows        — person → person acquaintance
--   met          — person → person/event encounter
--   located_at   — meeting/event → place
--   related_to   — generic same-topic linkage
--   supersedes   — newer version → older version (for hot_memory)
--   contradicts  — fact conflict marker
--
-- inferred_confidence: 1.0 when written by explicit MCP `link` call
-- (the agent / a skill is asserting it), <1.0 when written by a
-- deterministic extractor (lower the more ambiguous the surface form).

CREATE TABLE IF NOT EXISTS links (
  id                   BIGSERIAL PRIMARY KEY,
  source_slug          TEXT NOT NULL,
  target_slug          TEXT NOT NULL,
  type                 TEXT NOT NULL,
  inferred_confidence  REAL NOT NULL DEFAULT 1.0,
  source_chunk_id      TEXT,
  written_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (source_slug) REFERENCES pages(slug) ON DELETE CASCADE,
  UNIQUE (source_slug, target_slug, type)
);

CREATE INDEX IF NOT EXISTS links_source_type_idx
  ON links(source_slug, type);

CREATE INDEX IF NOT EXISTS links_target_type_idx
  ON links(target_slug, type);

CREATE INDEX IF NOT EXISTS links_type_idx
  ON links(type);

-- Confidence range guard (0..1). Implemented as a CHECK constraint so
-- a bad extractor can't poison ranking with negative/>1 values.
ALTER TABLE links
  ADD CONSTRAINT links_confidence_range_chk
  CHECK (inferred_confidence >= 0.0 AND inferred_confidence <= 1.0);
