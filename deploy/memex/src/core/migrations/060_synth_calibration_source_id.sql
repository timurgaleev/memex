-- 060_synth_calibration_source_id.sql — per-tenant calibration profiles.
--
-- `synth_calibration_profile` was a single GLOBAL scorecard per run: the
-- calibration phase aggregated EVERY tenant's take-grades into one row and
-- `get_calibration_profile` handed that global aggregate to any caller. In the
-- multi-tenant deployment that (1) blended tenants' track records and (2) leaked
-- a figure derived from other tenants' graded takes. This adds the missing
-- `source_id` axis so a profile is scoped to the tenant whose takes it grades —
-- mirroring the reference's per-(source_id, holder) calibration table (memex has
-- no `holder` axis; source_id is the tenant boundary).
--
-- Additive + idempotent: ADD COLUMN IF NOT EXISTS is metadata-only, the NOT NULL
-- DEFAULT 'default' backfills every existing row to the legacy tenant (mig 047
-- registered 'default' in `sources`), and the index create is IF NOT EXISTS.
-- Single-tenant brains keep one profile named 'default' — behaviour-neutral.

-- 1. The tenancy column. Every legacy row backfills to 'default', the same
--    legacy-tenant convention migration 047 uses for the content tables. FK to
--    sources(id) matches the pages/links/tags/entity_facts pattern.
ALTER TABLE synth_calibration_profile
  ADD COLUMN IF NOT EXISTS source_id TEXT NOT NULL DEFAULT 'default'
    REFERENCES sources(id);

-- 2. Per-tenant recency lookup: get_calibration_profile filters by the caller's
--    effective source set and takes the newest row. Mirrors the reference's
--    (source_id, holder, generated_at DESC) recency index, minus the holder axis.
CREATE INDEX IF NOT EXISTS synth_calibration_profile_source_time_idx
  ON synth_calibration_profile (source_id, generated_at DESC);
