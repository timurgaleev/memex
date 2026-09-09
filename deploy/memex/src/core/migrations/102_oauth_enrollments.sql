-- 102_oauth_enrollments.sql — the identity half of per-grant tenancy.
--
-- Migration 101 let a grant carry its own source, so ONE connector can serve
-- many people. What it did not answer is how /authorize learns WHICH source a
-- given authorisation belongs to. memex has no per-user login (the admin login
-- accepts only the operator bootstrap token), and a corporate chat vendor's
-- connector catalogue is shared by the whole organisation — so the person in
-- front of /authorize has nothing to present but what the operator gave them.
--
-- An enrollment code is that thing: issued by the operator for one source,
-- single-use, short-lived, and dead the moment it binds a grant. The connector
-- popup asks for it once; from then on the refresh token carries the source.

-- Which /authorize flow a client uses.
--   'client'      — today's behaviour: the grant inherits the client row's
--                   source (auto-approve, or the operator-login gate).
--   'enrollment'  — /authorize requires a valid enrollment code and binds the
--                   grant to the code's source; the operator-login gate is
--                   NOT consulted, because the code IS the resource-owner
--                   authentication and the gate could only send the person to
--                   a login she cannot pass.
-- CHECKed, not free text: `getClient` parses this column on every request, so
-- a row with an unexpected value would take down /authorize, /token and every
-- token verification for that client.
ALTER TABLE oauth_clients
  ADD COLUMN IF NOT EXISTS tenant_mode TEXT NOT NULL DEFAULT 'client';

DO $$
BEGIN
  ALTER TABLE oauth_clients
    ADD CONSTRAINT oauth_clients_tenant_mode_chk
    CHECK (tenant_mode IN ('client', 'enrollment'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS oauth_enrollments (
  id             TEXT PRIMARY KEY,
  -- sha256 of the code. The code itself is printed once at issue and never
  -- stored, exactly like a client secret.
  code_hash      TEXT NOT NULL UNIQUE,
  -- When set, only this client may redeem the code; NULL = any client in
  -- enrollment mode.
  client_id      TEXT NULL,
  -- Validated against `sources` at issue time. Deliberately NOT a foreign key:
  -- see migration 101 for why a FK here would either widen or sever live
  -- grants when a source is dropped.
  source_id      TEXT NOT NULL,
  federated_read TEXT[] NOT NULL,
  -- The operator's own note ("tina"); never shown to the person redeeming.
  label          TEXT NULL,
  expires_at     TIMESTAMPTZ NOT NULL,
  -- Single-use. `used_code_hash` links to the oauth_codes row the claim
  -- produced, for the audit trail.
  used_at        TIMESTAMPTZ NULL,
  used_code_hash TEXT NULL,
  -- Operator kill switch for a code that leaked before it was redeemed.
  revoked_at     TIMESTAMPTZ NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- "Which codes are still live?" for the operator's listing.
CREATE INDEX IF NOT EXISTS idx_oauth_enrollments_live
  ON oauth_enrollments (expires_at)
  WHERE used_at IS NULL AND revoked_at IS NULL;
