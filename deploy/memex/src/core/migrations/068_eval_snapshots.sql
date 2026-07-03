-- 068_eval_snapshots.sql — periodic retrieval-quality probe history.
--
-- The eval-replay harness (core/eval-replay.ts) replays the captured
-- eval_queries against the live brain and produces a ReplayReport
-- (meanRR, hitRate, scored counts). That run is on-demand today. This table
-- gives a cheap nightly probe (see deploy/systemd/memex-eval-probe.*) a durable
-- place to append ONE row per run, so `doctor` can read the trend without
-- re-running retrieval.
--
-- One row per probe run. Nothing else writes here; a run that scores zero
-- queries (empty eval set) still records a row so an absent trend is
-- distinguishable from a broken probe. Rows are never updated — append-only
-- history, cheap to prune by created_at if it ever grows.
--
-- No source axis: the probe replays the operator's whole-brain eval set (the
-- same unscoped harness the CLI `eval-replay run` uses), so a snapshot is a
-- brain-level health signal, not a per-tenant one.

CREATE TABLE IF NOT EXISTS eval_snapshots (
  id            BIGSERIAL PRIMARY KEY,
  ran_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  total_queries INTEGER NOT NULL DEFAULT 0,
  scored        INTEGER NOT NULL DEFAULT 0,
  mean_rr       REAL NOT NULL DEFAULT 0,
  hit_rate      REAL NOT NULL DEFAULT 0,
  -- Full ReplayReport aggregate block (baseline deltas, stability) as JSON so a
  -- reader can surface detail without a schema change per new metric.
  detail        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS eval_snapshots_ran_at_idx
  ON eval_snapshots (ran_at DESC);
