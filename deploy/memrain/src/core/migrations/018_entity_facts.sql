-- 018_entity_facts.sql — append-only fact ledger per entity.
--
-- "Entity" here is the same `slug` namespace as `pages` and the
-- `target_slug` column on `links`. A fact attaches a short claim to
-- an entity, with provenance (where it came from) and confidence
-- (how strong the evidence is).
--
-- Examples:
--   entity_slug=people/alice, fact="ex-CFO at Acme",
--     source_slug=meetings/2024-03-10, confidence=0.95
--   entity_slug=companies/acme, fact="raised Series B March 2024",
--     source_slug=email/ndljdj, confidence=1.0
--
-- Like timeline_events, this is append-only and dedup'd by
-- (entity_slug, fact, source_chunk_id) so a recipe re-processing
-- the same chunk does not double-count. Manually-entered facts (no
-- source_chunk_id) skip dedup so the operator can record several
-- distinct nuance-of-the-same-claim entries without the partial
-- index merging them.
--
-- Soft entity_slug reference — no FK to pages. A fact may be
-- recorded about a stub entity before its page is created; the
-- dream cycle later auto-stubs pages for any entity_slug with
-- >= N facts (separate phase).

CREATE TABLE IF NOT EXISTS entity_facts (
  id              BIGSERIAL PRIMARY KEY,
  entity_slug     TEXT NOT NULL,
  fact            TEXT NOT NULL,
  confidence      REAL NOT NULL DEFAULT 1.0,
  source_slug     TEXT,
  source_chunk_id TEXT,
  written_by      TEXT,
  written_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT entity_facts_confidence_range_chk
    CHECK (confidence >= 0.0 AND confidence <= 1.0)
);

CREATE INDEX IF NOT EXISTS entity_facts_entity_time_idx
  ON entity_facts(entity_slug, written_at DESC);

CREATE INDEX IF NOT EXISTS entity_facts_entity_conf_idx
  ON entity_facts(entity_slug, confidence DESC);

CREATE INDEX IF NOT EXISTS entity_facts_source_idx
  ON entity_facts(source_slug)
  WHERE source_slug IS NOT NULL;

-- Idempotent ingestion: same (entity, fact, source_chunk) tuple
-- writes one row at most. Manual entries (NULL chunk_id) skip
-- dedup so the operator may layer slightly-different observations.
CREATE UNIQUE INDEX IF NOT EXISTS entity_facts_dedup_idx
  ON entity_facts (entity_slug, fact, source_chunk_id)
  WHERE source_chunk_id IS NOT NULL;
