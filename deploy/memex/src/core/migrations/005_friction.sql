-- memex schema migration 005: friction events.
--
-- Logs every "the agent got stuck / wrong / confused" moment so we can
-- spot patterns. Append-only from the runtime; the analyse query joins
-- this with chunks/documents to surface "topics where retrieval keeps
-- missing".

CREATE TABLE IF NOT EXISTS friction_events (
  id            BIGSERIAL PRIMARY KEY,
  captured_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  kind          TEXT NOT NULL,
  query         TEXT,
  reason        TEXT,
  source_path   TEXT,
  extra         JSONB DEFAULT '{}'::jsonb,
  CHECK (kind IN ('search-miss', 'wrong-answer', 'tool-error', 'low-confidence', 'other'))
);

CREATE INDEX IF NOT EXISTS friction_events_captured_at_idx
  ON friction_events(captured_at DESC);
CREATE INDEX IF NOT EXISTS friction_events_kind_idx
  ON friction_events(kind);
