-- 021_subagent_ledger.sql -- durable conversation + tool-use ledger
-- for sub-agent jobs.
--
-- When a parent job kicks off a sub-agent (an LLM loop with tool
-- calls), the supervisor needs to be able to crash, restart, and
-- pick up where it left off WITHOUT re-running tools that have
-- already executed (idempotency on duplicate work) and without
-- losing the conversational thread (the model needs the prior
-- messages on resume).
--
-- Two tables:
--
--   * `subagent_messages` -- one row per turn in the conversation
--     (user / assistant / tool_result). `content` is jsonb to fit
--     the Bedrock Converse content-block shape.
--
--   * `subagent_tool_executions` -- one row per tool call. The
--     supervisor inserts a `pending` row BEFORE running the tool,
--     then transitions to `succeeded`/`failed` after. A crash
--     mid-call leaves a `pending` row that the supervisor's
--     resume path can either retry (idempotent tools) or skip
--     (best-effort tools that have already had their side effect).
--
-- A.5 ships SCHEMA only -- the subagent runner that fills these
-- rows lands in a future phase. The MCP surface (subagent_run,
-- subagent_logs, etc.) is deferred to the same phase.

CREATE TABLE IF NOT EXISTS subagent_messages (
  id          BIGSERIAL PRIMARY KEY,
  job_id      TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  turn_num    INTEGER NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('user','assistant','tool_result','system')),
  content     JSONB NOT NULL,
  written_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (job_id, turn_num)
);

CREATE INDEX IF NOT EXISTS subagent_messages_job_turn_idx
  ON subagent_messages(job_id, turn_num);

CREATE TABLE IF NOT EXISTS subagent_tool_executions (
  id          BIGSERIAL PRIMARY KEY,
  job_id      TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  turn_num    INTEGER NOT NULL,
  tool_name   TEXT NOT NULL,
  input       JSONB NOT NULL,
  output      JSONB,
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending','succeeded','failed','skipped')),
  error       TEXT,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS subagent_tool_executions_job_idx
  ON subagent_tool_executions(job_id, turn_num);

-- Index for the supervisor's crash-recovery sweep: "find any
-- pending tool executions older than N seconds and decide whether
-- to retry or skip them".
CREATE INDEX IF NOT EXISTS subagent_tool_executions_pending_idx
  ON subagent_tool_executions(started_at)
  WHERE status = 'pending';
