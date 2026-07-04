-- 069_synth_calibration_depth.sql — deepen the calibration profile to parity.
--
-- The calibration phase wrote only an `accuracy` figure per tenant. The
-- reference's per-(source_id, holder) calibration table carries a richer
-- scorecard: a Brier score over the forecaster's stated conviction vs the
-- realized outcome, a partial_rate, a per-domain breakdown, and the fraction
-- of gradable takes the grade phase actually processed. This adds those four
-- fields to `synth_calibration_profile` so a profile row is a full scorecard,
-- not just one accuracy number.
--
-- Additive + idempotent: every column is `ADD COLUMN IF NOT EXISTS` and
-- nullable (or NOT NULL DEFAULT for grade_completion, which backfills every
-- existing row to 1.0 — "fully graded", the behaviour-neutral prior). No data
-- rewrite, metadata-only. Single-tenant brains and pre-069 rows keep working:
-- the new columns read NULL / 1.0 until the next calibration run repopulates
-- them. Tenancy is unchanged — source_id (mig 060) still scopes every row.

-- Brier score over decided (correct∨incorrect) takes: mean (weight − outcome)²
-- where outcome = 1 for correct, 0 for incorrect. Lower is better-calibrated.
-- Matches the reads-side `getTakesScorecard` Brier definition byte-for-byte so
-- the profile row and the live scorecard never disagree.
ALTER TABLE synth_calibration_profile
  ADD COLUMN IF NOT EXISTS brier DOUBLE PRECISION;

-- partial / resolved — the share of resolved takes that landed as a hedge.
ALTER TABLE synth_calibration_profile
  ADD COLUMN IF NOT EXISTS partial_rate DOUBLE PRECISION;

-- Fraction of the tenant's takes that carry a grade at profile time. < 1.0
-- means the grade phase hasn't caught up (or capped on budget); a dashboard
-- can surface a "built on N% graded" caveat. Backfills to 1.0 (fully graded).
ALTER TABLE synth_calibration_profile
  ADD COLUMN IF NOT EXISTS grade_completion DOUBLE PRECISION NOT NULL DEFAULT 1.0;

-- Per-domain scorecards keyed by the take's `domain` (free-form on synth_takes).
-- JSONB object: { "<domain>": { n, correct, incorrect, partial, accuracy,
-- brier, partial_rate }, ... }. Empty {} when no take carries a domain.
ALTER TABLE synth_calibration_profile
  ADD COLUMN IF NOT EXISTS domain_scorecards JSONB NOT NULL DEFAULT '{}'::jsonb;
