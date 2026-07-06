-- 089: search_telemetry — per-day (date, mode, intent) search rollup.
--
-- Reference-parity observability substrate for `memex search stats|tune`:
-- rows are SUMS + COUNTS only, never averages — read-time derives averages, so
-- concurrent ON CONFLICT adds from multiple processes accumulate correctly.
-- PK (date, mode, intent) bounds growth to ~4–5K rows/year.
--
-- rank-1 drift columns (the reference's follow-up wave, folded in here since
-- both land together): sum/count of the top hit's fused score plus three
-- coarse bands derived from the evidence class (memex has no calibrated 0..1
-- cosine base_score — see core/search/telemetry.ts for the band mapping).

CREATE TABLE IF NOT EXISTS search_telemetry (
  date                TEXT             NOT NULL,
  mode                TEXT             NOT NULL,
  intent              TEXT             NOT NULL,
  count               INTEGER          NOT NULL DEFAULT 0,
  sum_results         INTEGER          NOT NULL DEFAULT 0,
  sum_tokens          INTEGER          NOT NULL DEFAULT 0,
  sum_budget_dropped  INTEGER          NOT NULL DEFAULT 0,
  cache_hit           INTEGER          NOT NULL DEFAULT 0,
  cache_miss          INTEGER          NOT NULL DEFAULT 0,
  sum_rank1_score     DOUBLE PRECISION NOT NULL DEFAULT 0,
  count_rank1         INTEGER          NOT NULL DEFAULT 0,
  rank1_lt_solid      INTEGER          NOT NULL DEFAULT 0,
  rank1_solid         INTEGER          NOT NULL DEFAULT 0,
  rank1_high          INTEGER          NOT NULL DEFAULT 0,
  first_seen          TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
  last_seen           TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
  PRIMARY KEY (date, mode, intent)
);

CREATE INDEX IF NOT EXISTS idx_search_telemetry_date
  ON search_telemetry (date DESC);
