-- 078_raw_data_unique.sql — upsert key for the raw-data sidecar
-- (UNIQUE(page, source)).
--
-- raw_data (mig023) was laid down as a passive store with no constraint, so a
-- writer re-fetching the same API payload for the same page appends forever —
-- and there is no conflict target for an upsert. The sidecar is keyed
-- UNIQUE(slug, source) and REPLACES the payload on re-put.
--
-- Pre-clean: the table had no constraint, so duplicates may exist. The row
-- kept is the NEWEST (highest id) — a raw sidecar is a cache of the latest
-- fetched payload, not a history (the upsert has the same
-- newest-wins semantics). Older duplicates carry no product data that the
-- newest row doesn't supersede.

DELETE FROM raw_data a
 USING raw_data b
 WHERE a.slug = b.slug
   AND a.source = b.source
   AND a.id < b.id;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'raw_data_slug_source_key'
  ) THEN
    ALTER TABLE raw_data
      ADD CONSTRAINT raw_data_slug_source_key UNIQUE (slug, source);
  END IF;
END $$;
