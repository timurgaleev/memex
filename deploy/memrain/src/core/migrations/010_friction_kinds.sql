-- memex schema migration 010: expand friction model.
--
-- Adds a `severity` column (advisory severity for triage) and broadens
-- the `kind` enum to include positive markers (`delight`) and lifecycle
-- markers (`phase-marker`, `interrupted`). The original 005 migration
-- only modelled the negative-event side; this lets the same logbook
-- also capture "something went notably right" and "this op started/
-- ended" so propose-fix has more context to learn from.

ALTER TABLE friction_events
  ADD COLUMN IF NOT EXISTS severity TEXT
    CHECK (severity IS NULL OR severity IN ('confused', 'error', 'blocker', 'nit'));

-- Replace the original CHECK on `kind` with a wider enum. The auto-name
-- the original migration produced is `friction_events_kind_check` on
-- both Postgres and PGLite (single-column unnamed CHECK convention);
-- DROP IF EXISTS makes it safe even if the name diverged on some host.
ALTER TABLE friction_events
  DROP CONSTRAINT IF EXISTS friction_events_kind_check;
ALTER TABLE friction_events
  DROP CONSTRAINT IF EXISTS friction_events_check;

ALTER TABLE friction_events
  ADD CONSTRAINT friction_events_kind_check
    CHECK (kind IN (
      'search-miss',
      'wrong-answer',
      'tool-error',
      'low-confidence',
      'other',
      'delight',
      'phase-marker',
      'interrupted'
    ));

CREATE INDEX IF NOT EXISTS friction_events_severity_idx
  ON friction_events(severity);
