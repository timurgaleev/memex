-- 091: holder column on synth_takes — who HOLDS the belief (reference parity).
--
-- Migration 072 shipped the per-token `permissions.takes_holders` allow-list
-- knob (default ['world']) but nothing filtered by it: the column it gates
-- did not exist. This adds it, so the read paths (list_takes, takes_search,
-- scorecard, calibration) can enforce the allow-list a token carries.
--
-- Values: 'world' (consensus fact / consensus-candidate) | 'brain' (a private
-- AI hunch) | 'people/<slug>' | 'companies/<slug>' (fence grammar; legacy
-- bare slugs tolerated).
--
-- DEFAULT / backfill = 'world' (deliberate, see PARITY.md). memex retrofits a
-- holder onto pre-existing takes that were ALL machine-proposed and, crucially,
-- were world-visible (unfiltered) before this column existed. The operator
-- reads them daily through a REMOTE client (claude.ai / ChatGPT), which the
-- takes-holder fail-safe floors to ['world']. Backfilling to 'brain' would
-- retroactively hide the operator's entire live take history from their own
-- primary client — a regression, not a privacy win. So machine-proposed takes
-- stay 'world' (they are the brain's consensus CANDIDATES, surfaced for the
-- human to grade), and only fence-authored takes the operator marks otherwise
-- carry a non-world holder — the genuinely-private rows the floor must gate.
-- This is a memex-specific backfill choice, not a divergence from a reference
-- step (the reference authored takes with explicit holders from day one and
-- never backfilled machine takes).

ALTER TABLE synth_takes
  ADD COLUMN IF NOT EXISTS holder TEXT NOT NULL DEFAULT 'world';

CREATE INDEX IF NOT EXISTS synth_takes_holder_idx
  ON synth_takes (holder);
