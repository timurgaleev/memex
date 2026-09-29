-- 107_spend_ledger_tokens_and_pat_budget.sql — raw token counts on the spend
-- ledger, an honest "unknown" cost, and a daily cap for personal access tokens.
--
--   mcp_spend_log.*_tokens   what Bedrock reported for the call. NULL means it
--                            reported nothing (the call failed before usage).
--                            spend_cents alone could not say whether a $0 row
--                            was a free call, a failed one or an unpriced model.
--   mcp_spend_log.spend_cents
--                            may now be NULL: the model had no price, so the
--                            cost is unknown. A 0 there read as "free". Every
--                            reader sums it, and SUM skips NULL.
--   access_tokens.budget_usd_per_day
--                            a PAT's daily ceiling. Only OAuth clients could be
--                            capped; a PAT spends under its name, which matched
--                            no oauth_clients row, so it was always uncapped.
--
-- Additive, catalog-only on Postgres; no table rewrite.
ALTER TABLE mcp_spend_log
  ADD COLUMN IF NOT EXISTS input_tokens INTEGER,
  ADD COLUMN IF NOT EXISTS output_tokens INTEGER,
  ADD COLUMN IF NOT EXISTS cache_read_tokens INTEGER,
  ADD COLUMN IF NOT EXISTS cache_write_tokens INTEGER;
ALTER TABLE mcp_spend_log ALTER COLUMN spend_cents DROP NOT NULL;

ALTER TABLE access_tokens ADD COLUMN IF NOT EXISTS budget_usd_per_day NUMERIC(10, 2);
