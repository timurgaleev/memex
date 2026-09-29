-- 044_context_volunteer_events.sql — push-based context feedback log.
--
-- Wave-3: the brain VOLUNTEERS relevant pages from a
-- rolling conversation window (the volunteer_context op + `memex watch`)
-- instead of waiting to be asked. One row per page volunteered, written
-- fire-and-forget so logging can never fail the read.
--
-- "Used" is DERIVED, never written: a volunteered page counts as used when
-- `pages.last_retrieved_at > volunteered_at` (migration 024's write-back on
-- get/search is the open/cite signal). The join is APPROXIMATE by design —
-- last-retrieved is throttled (false negatives) and unrelated reads of the
-- same page match too (false positives); the stats surface carries the caveat.
--
-- Retention: rows older than 90 days are pruned by the cycle's purge phase
-- (purgeStaleVolunteerEvents) so conversation-adjacent telemetry never grows
-- unbounded. `rationale` is a deterministic template that may embed the matched
-- entity's surface form (which by construction resolved to an existing
-- alias/title/slug) — never free conversation text.
--
-- memex is a SINGLE-source flat vault, so there is no `source_id` page
-- scoping. The column is retained (nullable) to keep the row shape stable,
-- but every memex write leaves it NULL.

CREATE TABLE IF NOT EXISTS context_volunteer_events (
  id              BIGSERIAL PRIMARY KEY,
  source_id       TEXT,
  slug            TEXT NOT NULL,
  confidence      DOUBLE PRECISION,
  match_arm       TEXT,
  rationale       TEXT DEFAULT '',
  channel         TEXT DEFAULT 'op',
  session_id      TEXT,
  turn            INTEGER,
  volunteered_at  TIMESTAMPTZ DEFAULT now()
);

-- Indexes serve the two hot paths: the purge + stats range scan on
-- volunteered_at, and the stats join on slug. (source_id is always NULL on this
-- single-source brain, so a source_id-leading index would index nothing.)
CREATE INDEX IF NOT EXISTS context_volunteer_events_time_idx
  ON context_volunteer_events (volunteered_at DESC);

CREATE INDEX IF NOT EXISTS context_volunteer_events_slug_idx
  ON context_volunteer_events (slug);
