-- 090: operator-authored takes lifecycle on synth_takes (reference parity).
--
-- Today every synth_takes row is LLM-proposed and LLM-graded; the operator's
-- own claims have no home and calibration measures the judge model, not the
-- human. This adds the lifecycle axes of the operator-authored model:
--
--  1. Page-fence canon: `row_num` anchors a take to its row in a page's
--     fenced takes table (source_ref = the page/document, row_num = the
--     stable append-only row number). One row per (source_ref, row_num);
--     NULL for LLM-proposed rows, which keep their take_key idempotency.
--  2. active/superseded_by: a struck-through fence row goes inactive; a
--     supersede records which row replaced it. Both rows persist.
--  3. since/until: the fence's date range, TEXT ('YYYY-MM' or ISO date,
--     author's choice) — display + age-gating metadata, not a timestamp.
--  4. Resolution tuple (resolved_at/quality/outcome/value/unit/source/by):
--     how the claim actually turned out, resolved by a HUMAN (or by the
--     gated auto-resolve path stamping resolved_by='memex:grade_takes').
--     Distinct from synth_take_grades, which stay advisory judge verdicts.
--
-- The kind CHECK widens to admit the operator fence vocabulary
-- (fact/take/hunch) alongside the LLM-propose vocabulary; dropping and
-- re-adding the auto-named inline CHECK is deterministic + idempotent
-- (same pattern as migration 063's status widen).
--
-- Additive + idempotent: IF NOT EXISTS everywhere; nullable / defaulted
-- columns so pre-090 rows keep working (active defaults true, resolution
-- fields NULL = unresolved).

ALTER TABLE synth_takes
  ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE synth_takes
  ADD COLUMN IF NOT EXISTS superseded_by BIGINT;

ALTER TABLE synth_takes
  ADD COLUMN IF NOT EXISTS row_num INTEGER;

ALTER TABLE synth_takes
  ADD COLUMN IF NOT EXISTS since_date TEXT;

ALTER TABLE synth_takes
  ADD COLUMN IF NOT EXISTS until_date TEXT;

ALTER TABLE synth_takes
  ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;

ALTER TABLE synth_takes
  ADD COLUMN IF NOT EXISTS resolved_quality TEXT;

ALTER TABLE synth_takes
  ADD COLUMN IF NOT EXISTS resolved_outcome BOOLEAN;

ALTER TABLE synth_takes
  ADD COLUMN IF NOT EXISTS resolved_value DOUBLE PRECISION;

ALTER TABLE synth_takes
  ADD COLUMN IF NOT EXISTS resolved_unit TEXT;

ALTER TABLE synth_takes
  ADD COLUMN IF NOT EXISTS resolved_source TEXT;

ALTER TABLE synth_takes
  ADD COLUMN IF NOT EXISTS resolved_by TEXT;

ALTER TABLE synth_takes
  DROP CONSTRAINT IF EXISTS synth_takes_kind_check;

ALTER TABLE synth_takes
  ADD CONSTRAINT synth_takes_kind_check
  CHECK (kind IN ('prediction', 'judgment', 'bet', 'fact', 'take', 'hunch'));

-- The (quality, outcome) tuple must agree: correct↔true, incorrect↔false,
-- partial/unresolvable carry no boolean outcome. Defense-in-depth under
-- deriveResolutionTuple, which surfaces the CLI-friendly error first.
ALTER TABLE synth_takes
  DROP CONSTRAINT IF EXISTS synth_takes_resolution_consistency;

ALTER TABLE synth_takes
  ADD CONSTRAINT synth_takes_resolution_consistency
  CHECK (
    (resolved_quality IS NULL AND resolved_outcome IS NULL)
    OR (resolved_quality = 'correct' AND resolved_outcome IS TRUE)
    OR (resolved_quality = 'incorrect' AND resolved_outcome IS FALSE)
    OR (resolved_quality IN ('partial', 'unresolvable') AND resolved_outcome IS NULL)
  );

-- Fence canon: one derived row per (page, fence row). Partial so LLM-proposed
-- rows (row_num NULL) keep coexisting freely per source_ref.
CREATE UNIQUE INDEX IF NOT EXISTS synth_takes_fence_canon_idx
  ON synth_takes (source_ref, row_num)
  WHERE row_num IS NOT NULL;
