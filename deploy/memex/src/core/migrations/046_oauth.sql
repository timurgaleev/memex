-- 046_oauth.sql — OAuth 2.1 + bearer-token auth tables.
--
-- Foundation for multi-user / multi-tenant access (see docs/tenancy.md).
-- Purely additive: no existing table is touched, so this is safe to apply to
-- a live single-holder brain — the tables sit empty until the auth layer and
-- the source_id migration (047) land and a client is registered.
--
-- A verified token resolves to an AuthInfo carrying scopes[], a write
-- `source_id`, and a `federated_read[]` read set. `source_id` references the
-- existing `sources` table (migration 004) — the tenancy axis.

-- Bearer tokens for remote MCP access (admin-registered, long-lived).
CREATE TABLE IF NOT EXISTS access_tokens (
  id           BIGSERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  scopes       TEXT[],
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_access_tokens_hash
  ON access_tokens (token_hash) WHERE revoked_at IS NULL;

-- Per-request usage log for the admin dashboard.
CREATE TABLE IF NOT EXISTS mcp_request_log (
  id            SERIAL PRIMARY KEY,
  token_name    TEXT,
  agent_name    TEXT,
  operation     TEXT NOT NULL,
  latency_ms    INTEGER,
  status        TEXT NOT NULL DEFAULT 'success',
  params        JSONB,
  error_message TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mcp_log_time_agent
  ON mcp_request_log (created_at, token_name);
CREATE INDEX IF NOT EXISTS idx_mcp_log_agent_time
  ON mcp_request_log (agent_name, created_at DESC);

-- OAuth clients. `source_id` is the write-source scope; `federated_read` is
-- the read-source array (the tenancy grant). The agent-binding + per-day
-- budget columns are carried for forward-compatibility but unused in the MVP.
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id                  TEXT PRIMARY KEY,
  client_secret_hash         TEXT,
  client_name                TEXT NOT NULL,
  redirect_uris              TEXT[],
  grant_types                TEXT[] DEFAULT '{"client_credentials"}',
  scope                      TEXT,
  token_endpoint_auth_method TEXT,
  client_id_issued_at        BIGINT,
  client_secret_expires_at   BIGINT,
  token_ttl                  INTEGER,
  deleted_at                 TIMESTAMPTZ,
  source_id                  TEXT REFERENCES sources(id) ON DELETE RESTRICT,
  federated_read             TEXT[] NOT NULL DEFAULT '{}',
  budget_usd_per_day         NUMERIC(10, 2) NULL,
  bound_tools                TEXT[] NULL,
  bound_source_id            TEXT NULL,
  bound_slug_prefixes        TEXT[] NULL,
  bound_max_concurrent       INTEGER NOT NULL DEFAULT 1,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_oauth_clients_source_id
  ON oauth_clients (source_id) WHERE source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_oauth_clients_federated_read
  ON oauth_clients USING GIN (federated_read);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  token_hash   TEXT PRIMARY KEY,
  token_type   TEXT NOT NULL,
  client_id    TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  scopes       TEXT[],
  expires_at   BIGINT,
  resource     TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- A leaked token must be revocable before its natural expiry; verification
  -- gates on `revoked_at IS NULL`.
  revoked_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_oauth_tokens_expiry ON oauth_tokens (expires_at);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_client ON oauth_tokens (client_id);

CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash             TEXT PRIMARY KEY,
  client_id             TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  scopes                TEXT[],
  code_challenge        TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL DEFAULT 'S256',
  redirect_uri          TEXT NOT NULL,
  state                 TEXT,
  resource              TEXT,
  expires_at            BIGINT NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Sweep index for expired-code GC (cycle purge phase).
CREATE INDEX IF NOT EXISTS idx_oauth_codes_expiry ON oauth_codes (expires_at);
