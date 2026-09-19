-- 114_subagent_tool_binding.sql — bind each tool execution to the model's
-- tool-use id and to the claim that ran it.
--
-- The agent runner resumes a crashed job from the ledger. It must tell a tool
-- call it already ran (reuse the recorded result) from one an earlier attempt
-- left half-done (skip it, never re-run it with whatever input the row holds).
-- `tool_use_id` is the key it looks a call up by; the unique index makes a
-- replayed begin return the existing row instead of a second one.
-- `run_generation` is the jobs.claim_generation of the attempt that began the
-- row, so a pending row from any other attempt is recognisably foreign.
--
-- Additive; rows written before this migration carry NULL in both columns and
-- stay outside the index.
ALTER TABLE subagent_tool_executions ADD COLUMN IF NOT EXISTS tool_use_id TEXT;
ALTER TABLE subagent_tool_executions ADD COLUMN IF NOT EXISTS run_generation INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS subagent_tool_executions_tool_use_idx
  ON subagent_tool_executions(job_id, tool_use_id)
  WHERE tool_use_id IS NOT NULL;
