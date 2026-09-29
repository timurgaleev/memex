-- 070_entity_facts_metric_claims.sql — typed numeric-claim + event-type columns.
--
-- Extends entity_facts with five NULLABLE fields that turn a free-text fact into
-- a machine-readable typed claim, carried by the `## Facts` fence
-- (core/facts-fence.ts) and projected by the reconcile pass
-- (core/facts-reconcile.ts). They drive the metric-trajectory analysis in
-- core/insights.ts (regression detection + embedding drift_score):
--   - `claim_metric` — canonical metric label (lowercase snake_case, e.g.
--                      `mrr`, `arr`, `team_size`). Non-NULL marks a numeric claim.
--   - `claim_value`  — the numeric value of the claim (NUMERIC, arbitrary scale).
--   - `claim_unit`   — free-form unit string (`usd`, `people`, `pct`, …).
--   - `claim_period` — free-form period string (`monthly`, `annual`, …) or NULL
--                      for non-periodic metrics.
--   - `event_type`   — event-shaped row marker (`meeting`, `job_change`,
--                      `location_change`, …). Mutually informational with
--                      `claim_metric`: a row may carry either, both, or neither.
--
-- All five are additive (ADD COLUMN IF NOT EXISTS) and NULLABLE — no data
-- rewrite, no backfill, and every existing row (and every legacy fence without
-- these columns) keeps its current NULL-metadata behavior. No CHECK constraint:
-- the fence is hand-editable, `claim_metric`/`event_type` are free-form labels,
-- and the parser normalizes an unusable cell to NULL before it reaches the DB,
-- so a poisoned value degrades to NULL rather than aborting a page's reconcile.

ALTER TABLE entity_facts ADD COLUMN IF NOT EXISTS claim_metric TEXT;
ALTER TABLE entity_facts ADD COLUMN IF NOT EXISTS claim_value  NUMERIC;
ALTER TABLE entity_facts ADD COLUMN IF NOT EXISTS claim_unit   TEXT;
ALTER TABLE entity_facts ADD COLUMN IF NOT EXISTS claim_period TEXT;
ALTER TABLE entity_facts ADD COLUMN IF NOT EXISTS event_type   TEXT;

-- Metric-trajectory read path: fetch one entity's chronological metric claims
-- ordered by validity date. Partial index keeps it small (only typed rows).
CREATE INDEX IF NOT EXISTS entity_facts_metric_idx
  ON entity_facts (entity_slug, claim_metric, valid_from)
  WHERE claim_metric IS NOT NULL;
