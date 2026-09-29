-- 096_timeline_event_projection.sql — project event pages into the timeline.
--
-- An event page (a page whose content describes something that happened at a
-- time) projects one row into timeline_events. `event_slug` is the projecting
-- page: it links the timeline row back to the page it came from, and — via the
-- unique key below — makes re-projection an UPDATE of the existing row rather
-- than a duplicate insert every time the page is re-processed.
--
-- The uniqueness key is (event_slug, occurred-UTC-date): one projected row per
-- page per calendar day it fired. A plain `occurred_at::date` cast is only
-- STABLE (its result depends on the session TimeZone) and cannot back an index;
-- `(occurred_at AT TIME ZONE 'UTC')::date` is IMMUTABLE and does.
--
-- All additive + NULLABLE: rows that were never projected keep event_slug NULL
-- and stay out of both partial indexes, unchanged.

ALTER TABLE timeline_events ADD COLUMN IF NOT EXISTS event_slug TEXT;

-- FK to the projecting page. Guarded catalog check because Postgres has no
-- ADD CONSTRAINT IF NOT EXISTS; ON DELETE CASCADE so deleting the page clears
-- its projected timeline rows.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'timeline_events_event_slug_fkey'
       AND conrelid = 'timeline_events'::regclass
  ) THEN
    ALTER TABLE timeline_events
      ADD CONSTRAINT timeline_events_event_slug_fkey
      FOREIGN KEY (event_slug) REFERENCES pages(slug) ON DELETE CASCADE;
  END IF;
END $$;

-- Lookup path: projected rows for a given page.
CREATE INDEX IF NOT EXISTS timeline_events_event_slug_idx
  ON timeline_events (event_slug)
  WHERE event_slug IS NOT NULL;

-- Re-projection key: one row per (tenant, page, UTC calendar day). Leads with
-- source_id so the same event_slug in two tenants projects independently. The
-- IMMUTABLE AT TIME ZONE 'UTC' cast is what makes the date term indexable.
CREATE UNIQUE INDEX IF NOT EXISTS timeline_events_event_projection_key
  ON timeline_events (source_id, event_slug, ((occurred_at AT TIME ZONE 'UTC')::date))
  WHERE event_slug IS NOT NULL;
