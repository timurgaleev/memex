-- 056_synth_take_grades_ensemble.sql — record ensemble-grading provenance on
-- take grades. Additive + reversible: the opt-in multi-judge Sonnet ensemble
-- (MEMEX_TAKE_ENSEMBLE=1) writes how many judges voted and under which grader,
-- so an operator can tell an ensemble verdict from a single-pass Nova one.
--
-- Single-pass rows (the default path) leave both columns NULL — unchanged
-- behavior. No backfill; pure metadata add.
--
-- PGLite-safe: ADD COLUMN IF NOT EXISTS with no NOT NULL / no DEFAULT is a
-- metadata-only change.
ALTER TABLE synth_take_grades ADD COLUMN IF NOT EXISTS grader_model TEXT;
ALTER TABLE synth_take_grades ADD COLUMN IF NOT EXISTS judge_count INTEGER;
