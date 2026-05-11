-- memex schema migration 011: auto-capture for eval.
--
-- Every retrieval call going through `hybridSearch` (or the keyword
-- path) lands a row here when the runtime config has
-- evalCapture.enabled = true. Distinct from `eval_queries` which is
-- the curated regression set — `eval_candidates` is the raw firehose
-- you can later promote into `eval_queries` after a human tag.
--
-- PII expectation: queries are scrubbed in-process before INSERT when
-- evalCapture.scrub = true (default). Raw text never reaches this row
-- under that mode.

CREATE TABLE IF NOT EXISTS eval_candidates (
  id                BIGSERIAL PRIMARY KEY,
  captured_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  tool_name         TEXT NOT NULL,
  query             TEXT NOT NULL,
  scrubbed          BOOLEAN NOT NULL DEFAULT TRUE,
  k                 INTEGER NOT NULL DEFAULT 5,
  search_mode       TEXT NOT NULL DEFAULT 'hybrid',
  result_doc_ids    JSONB NOT NULL DEFAULT '[]'::jsonb,
  result_count      INTEGER NOT NULL DEFAULT 0,
  latency_ms        INTEGER NOT NULL DEFAULT 0,
  meta              JSONB NOT NULL DEFAULT '{}'::jsonb,
  remote            BOOLEAN NOT NULL DEFAULT FALSE,
  expand_enabled    BOOLEAN,
  detail            TEXT,
  job_id            TEXT,
  subagent_id       TEXT,
  CHECK (tool_name IN ('search', 'query', 'mcp.search', 'mcp.query', 'cli.search', 'http.search')),
  CHECK (search_mode IN ('hybrid', 'keyword')),
  CHECK (detail IS NULL OR detail IN ('low', 'medium', 'high'))
);

CREATE INDEX IF NOT EXISTS eval_candidates_captured_at_idx
  ON eval_candidates(captured_at DESC);
CREATE INDEX IF NOT EXISTS eval_candidates_tool_idx
  ON eval_candidates(tool_name);
