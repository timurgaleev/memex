-- 072: per-token permissions on access_tokens (reference v0.28 parity).
--
-- The verify path (oauth-provider.ts verifyToken, legacy fallback) already
-- reads `permissions.source_id` to derive a legacy bearer's tenant scope —
-- a scalar is both write source and sole read source, an array is a
-- federated read set anchored on its first element — and tolerates the
-- column being absent. This adds the column so the grant can actually be
-- stored: without it every PAT falls back to the 'default' floor.
--
-- Default {takes_holders:['world']} keeps non-world takes hidden from
-- MCP-bound tokens until the operator explicitly widens the allow-list.

ALTER TABLE access_tokens
  ADD COLUMN IF NOT EXISTS permissions JSONB
    NOT NULL DEFAULT '{"takes_holders":["world"]}'::jsonb;

-- NOT NULL DEFAULT covers new rows; this handles pre-existing rows from
-- before the column was added.
UPDATE access_tokens
   SET permissions = '{"takes_holders":["world"]}'::jsonb
 WHERE permissions IS NULL OR permissions = '{}'::jsonb;
