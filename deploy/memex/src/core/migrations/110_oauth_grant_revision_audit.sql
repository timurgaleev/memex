-- 110_oauth_grant_revision_audit.sql — revision + audit trail for client grants.
--
-- A rescope used to be one blind UPDATE: no way to detect that two operators
-- raced, no preview, and no record of who widened a grant or when. Each applied
-- grant change now bumps `grant_revision` (the optimistic-concurrency token a
-- caller passes back as its expected revision) and writes exactly one audit row
-- in the same statement.
--
-- Additive: existing clients start at revision 0. The audit table has no FK to
-- oauth_clients on purpose — `auth revoke-client` hard-deletes the client, and
-- the history of who shaped its grant must outlive it.
ALTER TABLE oauth_clients ADD COLUMN IF NOT EXISTS grant_revision INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS oauth_grant_audit (
  id          BIGSERIAL PRIMARY KEY,
  client_id   TEXT NOT NULL,
  -- The revision this change produced.
  revision    INTEGER NOT NULL,
  actor       TEXT NOT NULL,
  via         TEXT NOT NULL CHECK (via IN ('cli', 'admin_api', 'enrollment')),
  before      JSONB NOT NULL,
  after       JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (client_id, revision)
);

CREATE INDEX IF NOT EXISTS idx_oauth_grant_audit_client_created
  ON oauth_grant_audit (client_id, created_at DESC);
