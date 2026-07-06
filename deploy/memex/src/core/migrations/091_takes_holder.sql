-- 091: holder column on synth_takes — who HOLDS the belief (reference parity).
--
-- Migration 072 shipped the per-token `permissions.takes_holders` allow-list
-- knob (default ['world']) but nothing filtered by it: the column it gates
-- did not exist. This adds it, so the read paths (list_takes, takes_search,
-- scorecard, calibration) can enforce the allow-list a token carries.
--
-- Values: 'world' (consensus fact) | 'brain' (AI-inferred) |
-- 'people/<slug>' | 'companies/<slug>' (fence grammar; legacy bare slugs
-- tolerated). Existing rows backfill to 'brain': every pre-091 take was
-- LLM-proposed, i.e. the machine's inference — which also means they stay
-- hidden from tokens still on the mig-072 default ['world'] floor until the
-- operator widens the allow-list. The operator path (no token scope) is
-- unfiltered and sees everything.

ALTER TABLE synth_takes
  ADD COLUMN IF NOT EXISTS holder TEXT NOT NULL DEFAULT 'brain';

CREATE INDEX IF NOT EXISTS synth_takes_holder_idx
  ON synth_takes (holder);
