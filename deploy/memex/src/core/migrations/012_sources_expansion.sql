-- memex schema migration 012: sources expansion for multi-source ranking.
--
-- Pre-requisite for the deferred Gmail / GCal / code recipes
-- (TODO.md "External-dependency roadmap"). Each new recipe registers
-- a row here and references its `source_id` from the documents it
-- ingests. Per-source knobs let us tune ranking + ops independently:
--
--   - `rate_limit_per_minute` — caps how aggressively a recipe can
--     enqueue work. Gmail polling spikes shouldn't starve vault
--     reindex; jobs / throttle layers read this.
--   - `respect_quiet_hours` — opt-in flag: when true, the worker
--     skips this source's jobs during the Berlin 06:00–08:00 window
--     so morning briefing isn't fighting embed batches.
--   - `boost_weight` — ranking multiplier replacing the old hard-
--     coded per-kind boost in `core/search/source-boost.ts`. 1.0 is
--     neutral; >1 prefers the source, <1 demotes.
--   - `description` — human note for the operator, surfaced in
--     `memex sources show`.
--
-- Kind enum widened: + `code` (for the future code chunkers).

ALTER TABLE sources
  ADD COLUMN IF NOT EXISTS rate_limit_per_minute INTEGER NOT NULL DEFAULT 60
    CHECK (rate_limit_per_minute >= 0),
  ADD COLUMN IF NOT EXISTS respect_quiet_hours BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS boost_weight NUMERIC(4,2) NOT NULL DEFAULT 1.0
    CHECK (boost_weight >= 0),
  ADD COLUMN IF NOT EXISTS description TEXT;

-- Replace the kind CHECK to admit `code`. Same pattern as migration
-- 010 used for friction_events.
ALTER TABLE sources
  DROP CONSTRAINT IF EXISTS sources_kind_check;
ALTER TABLE sources
  DROP CONSTRAINT IF EXISTS sources_check;
ALTER TABLE sources
  ADD CONSTRAINT sources_kind_check
    CHECK (kind IN (
      'vault',
      'memory',
      'webhook',
      'mailbox',
      'calendar',
      'transcript',
      'code',
      'other'
    ));

-- Index on kind for `sources list --kind X` filters.
CREATE INDEX IF NOT EXISTS sources_kind_idx ON sources(kind);
