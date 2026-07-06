-- 079_timeline_dedup_detail.sql — manual-write dedup + summary/detail split
-- for timeline_events (reference parity: idx_timeline_dedup + source label).
--
-- The mig017 dedup key (slug, occurred_at, source_chunk_id) is PARTIAL —
-- `WHERE source_chunk_id IS NOT NULL` — so manual/API writes (no chunk id)
-- have NO dedup at all: an agent that retries `timeline_add`, or two recipes
-- emitting the same event without chunk provenance, duplicate rows forever.
-- The reference's idx_timeline_dedup is unconditional over
-- (page, date, summary, source). memex keeps the chunk-keyed index for
-- chunk-sourced rows (a chunk id is a stronger identity than wording) and
-- adds the reference-shaped key for the NULL-chunk rows.
--
-- New columns (both NOT NULL DEFAULT '' so legacy rows keep behavior):
--   - detail       — the reference's summary/detail split: `event` stays the
--                    one-line summary; `detail` carries the longer narrative.
--   - source_label — the reference's `source` provenance label ('granola',
--                    'manual', an importer name). Named source_label because
--                    memex already uses source_id for the tenant axis and
--                    source_chunk_id for chunk provenance. Part of the dedup
--                    key so distinct provenance survives (the reference
--                    widened its key for exactly this).
--
-- Pre-clean: existing manual duplicates (same slug/time/wording/label/tenant)
-- collapse to the OLDEST row (lowest id) — append-only ledger, first write is
-- the original.

ALTER TABLE timeline_events ADD COLUMN IF NOT EXISTS detail       TEXT NOT NULL DEFAULT '';
ALTER TABLE timeline_events ADD COLUMN IF NOT EXISTS source_label TEXT NOT NULL DEFAULT '';

DELETE FROM timeline_events a
 USING timeline_events b
 WHERE a.source_chunk_id IS NULL
   AND b.source_chunk_id IS NULL
   AND a.slug = b.slug
   AND a.occurred_at = b.occurred_at
   AND a.event = b.event
   AND a.source_label = b.source_label
   AND a.source_id = b.source_id
   AND a.id > b.id;

CREATE UNIQUE INDEX IF NOT EXISTS timeline_events_manual_dedup_idx
  ON timeline_events (slug, occurred_at, event, source_label, source_id)
  WHERE source_chunk_id IS NULL;
