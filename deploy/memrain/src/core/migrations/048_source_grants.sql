-- 048_source_grants.sql — server-side entitlement floor for OAuth subjects.
--
-- The tenancy grant (which source a JWT subject may write to + the federated
-- read set) MUST NOT be trusted from token claims: a `source_id` /
-- `federated_read` claim is user-influenceable and would let any validly-signed
-- token mint its own scope. This table is the authoritative, server-side store
-- of that grant, keyed by the JWT `sub`. The IdP only proves identity (sub);
-- the grant is provisioned here, out-of-band. See docs/tenancy.md.
--
-- Purely additive and PGLite-safe (no pgcrypto / gen_random_uuid). Sits empty
-- until subjects are provisioned; an un-provisioned subject resolves to no
-- grant (unscoped public-redacted read — the existing public default).
CREATE TABLE IF NOT EXISTS source_grants (
  sub             TEXT PRIMARY KEY,
  source_id       TEXT REFERENCES sources(id),
  federated_read  TEXT[] NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
