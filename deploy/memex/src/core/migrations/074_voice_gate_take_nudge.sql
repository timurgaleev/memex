-- 074: calibration UX — voice-gate audit fields + take-commit nudge log.
--
-- 1. Voice gate audit (synth_calibration_profile): the calibration narrative's
--    pattern statements now pass through a Haiku voice judge (conversational vs
--    academic) with up to 2 regenerations before falling back to the
--    deterministic template. The outcome is recorded per profile row so the
--    operator can review failing examples and tune the rubric — suppressing the
--    surface silently is never an option.
-- 2. take_nudge_log: every real-time bias nudge fired on take commit is logged
--    keyed on (take_id, nudge_pattern) with a 14-day cooldown probe reading this
--    table, so the same pattern never re-fires on every cycle.
--
-- Additive + idempotent: IF NOT EXISTS everywhere; nullable / defaulted columns
-- so pre-074 rows keep working (NULL voice_gate_passed = "predates the gate").

ALTER TABLE synth_calibration_profile
  ADD COLUMN IF NOT EXISTS voice_gate_passed BOOLEAN;

ALTER TABLE synth_calibration_profile
  ADD COLUMN IF NOT EXISTS voice_gate_attempts INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS take_nudge_log (
  id            BIGSERIAL PRIMARY KEY,
  source_id     TEXT,
  take_id       BIGINT NOT NULL,
  nudge_pattern TEXT NOT NULL,
  channel       TEXT NOT NULL DEFAULT 'stderr',
  fired_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS take_nudge_log_cooldown_idx
  ON take_nudge_log (take_id, nudge_pattern, fired_at DESC);
