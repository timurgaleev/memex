-- 119_write_requests.sql — idempotent writes keyed by a caller's request_id.
--
-- One row per (principal, tool, request_id). `principal` is the caller's grant
-- identity ('operator' for the trusted local path), so ids from different
-- callers never meet. `args_hash` fingerprints the call's arguments: a reuse of
-- the id with other arguments is refused rather than replayed. `result` is
-- NULL while the first call is still running and holds its response once it
-- completes; a retry with the same key replays it and writes nothing.
--
-- Rows are pruned after 7 days by the cycle's purge phase. Additive.
CREATE TABLE IF NOT EXISTS write_requests (
  principal   TEXT NOT NULL,
  tool        TEXT NOT NULL,
  request_id  TEXT NOT NULL,
  args_hash   TEXT NOT NULL,
  result      JSONB NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (principal, tool, request_id)
);

CREATE INDEX IF NOT EXISTS idx_write_requests_created_at
  ON write_requests (created_at);
