-- 073: widen the contradiction probe — typed resolutions, verdict TTL cache,
-- per-run trend rows.
--
-- Three additions, all advisory (nothing here mutates a fact/take/edge):
--   1. `resolution_kind` on synth_contradictions — the probe now classifies each
--      finding into a typed resolution proposal (supersede | debate | synthesize
--      | manual) alongside the free-text resolution_command, via a
--      deterministic resolution classifier.
--   2. synth_contradiction_verdicts — a TTL'd cache of EVERY judge verdict
--      (positive AND negative). Pre-073 only positives persisted (via the
--      synth_contradictions pair_key), so every negative pair was re-judged —
--      re-spent — on every run. The cache is keyed on pair_key (which already
--      folds in prompt_version) so a prompt bump cleanly invalidates it.
--   3. synth_contradiction_runs — one row per probe run (Wilson 95% CI over the
--      contradiction rate, cost, duration) so the probe has a trend surface.
--
-- Additive + idempotent: IF NOT EXISTS everywhere; no data rewrite.

ALTER TABLE synth_contradictions
  ADD COLUMN IF NOT EXISTS resolution_kind TEXT NOT NULL DEFAULT 'manual';

-- Judge verdict cache. `contradicts` is the headline; `verdict` keeps the full
-- parsed judgment for replay. expires_at drives the TTL (default 30 days at the
-- application layer); an expired row is treated as a miss and overwritten.
CREATE TABLE IF NOT EXISTS synth_contradiction_verdicts (
  pair_key    TEXT PRIMARY KEY,
  contradicts BOOLEAN NOT NULL,
  verdict     JSONB NOT NULL DEFAULT '{}'::jsonb,
  model_id    TEXT NOT NULL,
  judged_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS synth_contradiction_verdicts_expires_idx
  ON synth_contradiction_verdicts (expires_at);

-- Per-run trend rows. wilson_ci_* bound the true contradiction rate given
-- `judged` trials and `found` positives (95% Wilson score interval).
CREATE TABLE IF NOT EXISTS synth_contradiction_runs (
  run_id          TEXT PRIMARY KEY,
  ran_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  model_id        TEXT NOT NULL,
  prompt_version  TEXT NOT NULL,
  pairs_scanned   INTEGER NOT NULL DEFAULT 0,
  judged          INTEGER NOT NULL DEFAULT 0,
  found           INTEGER NOT NULL DEFAULT 0,
  cache_hits      INTEGER NOT NULL DEFAULT 0,
  wilson_ci_lower DOUBLE PRECISION NOT NULL DEFAULT 0,
  wilson_ci_upper DOUBLE PRECISION NOT NULL DEFAULT 0,
  cost_usd        DOUBLE PRECISION NOT NULL DEFAULT 0,
  duration_ms     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS synth_contradiction_runs_ran_at_idx
  ON synth_contradiction_runs (ran_at DESC);
