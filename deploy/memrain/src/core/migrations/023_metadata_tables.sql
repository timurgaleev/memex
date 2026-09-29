-- 023_metadata_tables.sql — lightweight metadata substrate.
--
-- All four tables are passive stores with no app-layer logic yet; their
-- consumers land in later phases. Listed here so the data model is ready.
--
--   tags        page-scoped tag list (distinct from global entity_mentions).
--   raw_data    sidecar JSONB per page (API responses, headers) for richer
--               downstream context.
--   config      brain-level k/v (embedding_model, dimensions) — a DB-side
--               override surface on top of core/config.ts defaults.
--   ingest_log  per-source audit of ingestion runs + which pages they
--               touched, for observability.

CREATE TABLE IF NOT EXISTS tags (
  slug       TEXT NOT NULL,
  tag        TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (slug, tag)
);
CREATE INDEX IF NOT EXISTS tags_tag_idx ON tags(tag);

CREATE TABLE IF NOT EXISTS raw_data (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug       TEXT NOT NULL,
  source     TEXT NOT NULL,
  data       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS raw_data_slug_idx ON raw_data(slug);

CREATE TABLE IF NOT EXISTS config (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ingest_log (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_type   TEXT NOT NULL,
  source_ref    TEXT,
  pages_updated JSONB NOT NULL DEFAULT '[]'::jsonb,
  summary       TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ingest_log_source_idx
  ON ingest_log(source_type, created_at DESC);
