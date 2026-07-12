-- 081_spend_ledger.sql — DB-backed spend accounting for paid LLM calls
-- (adds mcp_spend_log + mcp_spend_reservations).
--
-- The mig046 oauth_clients.budget_usd_per_day column was carried "for
-- forward-compatibility but unused in the MVP": the paid Sonnet slices track
-- spend with an in-process BudgetTracker that resets on restart and is blind
-- across processes. These two tables make spend durable so the per-client
-- daily cap is actually enforceable:
--
--   - mcp_spend_log          — one row per completed paid call (actuals). The
--                              per-day rollup is SUM(spend_cents) over a
--                              (client_id, created_at) range scan.
--   - mcp_spend_reservations — pre-flight holds. A caller reserves the
--                              ESTIMATED cost before spending, settles with
--                              the actual after, so two concurrent calls can't
--                              both slip under the cap. Process death between
--                              reserve and settle is cleaned by the
--                              expires_at TTL sweep ('expired').
--
-- memex has no resolver subsystem, so there is no separate resolver-scoped
-- budget ledger — the reservation table above IS the ledger for the one
-- spender class (client-attributed MCP/LLM calls).
--
-- Amounts are NUMERIC(12,4) cents (fractional cents matter at per-call
-- granularity; float never touches money).
--
-- No date_trunc index: TIMESTAMPTZ truncation is session-timezone-dependent
-- (not IMMUTABLE); the (client_id, created_at) BTREE covers the day-window
-- rollup via range scan.

CREATE TABLE IF NOT EXISTS mcp_spend_log (
  id          BIGSERIAL PRIMARY KEY,
  client_id   TEXT,
  token_name  TEXT,
  operation   TEXT NOT NULL,
  spend_cents NUMERIC(12, 4) NOT NULL DEFAULT 0,
  provider    TEXT,
  model       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mcp_spend_log_client_time
  ON mcp_spend_log (client_id, created_at);
CREATE INDEX IF NOT EXISTS idx_mcp_spend_log_token_time
  ON mcp_spend_log (token_name, created_at);

CREATE TABLE IF NOT EXISTS mcp_spend_reservations (
  reservation_id  TEXT PRIMARY KEY,
  client_id       TEXT NOT NULL,
  estimated_cents NUMERIC(12, 4) NOT NULL,
  actual_cents    NUMERIC(12, 4),
  model           TEXT NOT NULL,
  provider        TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'settled', 'expired')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  settled_at      TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mcp_spend_reservations_client_time
  ON mcp_spend_reservations (client_id, created_at);
CREATE INDEX IF NOT EXISTS idx_mcp_spend_reservations_pending_expires
  ON mcp_spend_reservations (status, expires_at)
  WHERE status = 'pending';
