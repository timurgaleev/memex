-- memex schema migration 003: cycle snapshots.
--
-- Each cycle phase appends one row so `reports` can render
-- trends. Append-only, no updates or deletes from app code.

CREATE TABLE IF NOT EXISTS cycle_snapshots (
  id            BIGSERIAL PRIMARY KEY,
  captured_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  documents       INTEGER NOT NULL,
  chunks          INTEGER NOT NULL,
  embeddings      INTEGER NOT NULL,
  entities        INTEGER NOT NULL,
  entity_mentions INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS cycle_snapshots_captured_at_idx
  ON cycle_snapshots(captured_at DESC);
