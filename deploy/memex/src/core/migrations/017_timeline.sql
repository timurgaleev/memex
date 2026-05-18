-- 017_timeline.sql — per-page append-only event log.
--
-- A timeline event is "something happened at a time, attached to a
-- page". Examples: "Alice changed jobs on 2024-03-10"; "Met Bob at
-- the conference on 2025-11-22"; "Project X launched 2026-01-15".
-- The `slug` is what the event is about (the person, project, or
-- meeting); `occurred_at` is when the event happened (NOT when it was
-- recorded). `event` is the human-readable description.
--
-- Append-only by design. Old events are never edited — corrections
-- become new events that say "actually, the previous claim was X".
-- Dedup is enforced on (slug, occurred_at, source_chunk_id) so a
-- recipe re-processing the same source chunk does not duplicate
-- rows; facts entered manually (no source_chunk_id) skip dedup.

CREATE TABLE IF NOT EXISTS timeline_events (
  id              BIGSERIAL PRIMARY KEY,
  slug            TEXT NOT NULL,
  occurred_at     TIMESTAMPTZ NOT NULL,
  event           TEXT NOT NULL,
  source_chunk_id TEXT,
  written_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (slug) REFERENCES pages(slug) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS timeline_events_slug_time_idx
  ON timeline_events(slug, occurred_at DESC);

CREATE INDEX IF NOT EXISTS timeline_events_occurred_idx
  ON timeline_events(occurred_at DESC);

-- Idempotent ingestion: a recipe that re-emits the same event from
-- the same chunk does not create duplicate rows. The partial index
-- intentionally excludes NULL chunk_id rows so manually-entered
-- events with the same (slug, time) wording can still coexist.
CREATE UNIQUE INDEX IF NOT EXISTS timeline_events_dedup_idx
  ON timeline_events (slug, occurred_at, source_chunk_id)
  WHERE source_chunk_id IS NOT NULL;
