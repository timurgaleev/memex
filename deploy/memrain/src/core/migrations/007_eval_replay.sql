-- memex schema migration 007: eval-replay regression harness.
--
-- Captures real production search calls + a "good / bad" tag so we can
-- re-run the set after any RRF / source-boost / two-pass tweak and see
-- the score delta vs the last baseline.
--
-- One table, baseline columns inline: a separate runs-history table
-- would buy nothing today (the only consumer is "compare vs the most
-- recent run we trusted"). Add eval_runs later if we need a charting
-- timeline.

CREATE TABLE IF NOT EXISTS eval_queries (
  id                  TEXT PRIMARY KEY,
  captured_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  query               TEXT NOT NULL,
  k                   INTEGER NOT NULL DEFAULT 5,
  expected_doc_id     TEXT,
  tag                 TEXT NOT NULL,
  source              TEXT NOT NULL DEFAULT 'manual',
  notes               TEXT,

  -- Baseline snapshot (populated by `eval-replay run --promote`).
  -- baseline_doc_ids is a JSONB array (string[]) for PGLite/Postgres parity.
  baseline_doc_ids    JSONB,
  baseline_rank       INTEGER,
  baseline_hit        BOOLEAN,
  baseline_rr         NUMERIC(8,6),
  baseline_ran_at     TIMESTAMPTZ,

  CHECK (tag IN ('good', 'bad')),
  CHECK (k BETWEEN 1 AND 100)
);

CREATE INDEX IF NOT EXISTS eval_queries_tag_idx ON eval_queries (tag);
CREATE INDEX IF NOT EXISTS eval_queries_captured_at_idx
  ON eval_queries (captured_at DESC);
