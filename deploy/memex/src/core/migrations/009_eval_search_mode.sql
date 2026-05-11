-- memex schema migration 009: eval-replay search-mode capture.
--
-- Production retrieval has two paths: keyword-only (`POST /search` with
-- explicit `?keyword=true`, or the bare CLI helper) and the default
-- hybrid (vector + keyword + RRF). When we capture an eval query we
-- want to remember which path produced the user's good/bad judgment so
-- the replay re-runs the same path — otherwise a hybrid replay of a
-- keyword-only capture would be measuring the wrong thing.

ALTER TABLE eval_queries
  ADD COLUMN IF NOT EXISTS search_mode TEXT NOT NULL DEFAULT 'hybrid'
    CHECK (search_mode IN ('hybrid', 'keyword'));
