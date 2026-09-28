-- 117_oauth_token_lifecycle.sql — refresh-token families, per-client token
-- lifetimes, and the client revision a code was approved under.
--
-- Refresh families (OAuth 2.1 §4.3.1): every access and refresh token minted
-- from one authorization carries the same `family_id`, and a consumed refresh
-- token leaves its hash behind in `oauth_refresh_consumed`. Presenting that hash
-- again after the grace window means two parties hold the chain, so the whole
-- family is revoked. Tokens issued before this carry NULL and start a family
-- the next time they rotate.
--
-- All columns are nullable; NULL keeps today's behaviour.
ALTER TABLE oauth_tokens ADD COLUMN IF NOT EXISTS family_id TEXT;

CREATE INDEX IF NOT EXISTS idx_oauth_tokens_family ON oauth_tokens (family_id)
  WHERE family_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS oauth_refresh_consumed (
  token_hash  TEXT PRIMARY KEY,
  family_id   TEXT NOT NULL,
  client_id   TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  -- Unix epoch seconds, like oauth_tokens.expires_at.
  consumed_at BIGINT NOT NULL,
  -- The consumed token's own expiry: past it, a replay is refused as unknown
  -- anyway, so the row is swept.
  expires_at  BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_oauth_refresh_consumed_expiry
  ON oauth_refresh_consumed (expires_at);

-- Per-client lifetimes, bounded where they are set. NULL = the server default.
ALTER TABLE oauth_clients ADD COLUMN IF NOT EXISTS access_ttl_seconds INTEGER;
ALTER TABLE oauth_clients ADD COLUMN IF NOT EXISTS refresh_ttl_seconds INTEGER;

-- The client's grant_revision when /authorize approved the code. /token refuses
-- the code once the client has been rescoped since. NULL on codes minted before
-- this migration, which are redeemed as before.
ALTER TABLE oauth_codes ADD COLUMN IF NOT EXISTS grant_revision INTEGER;

-- grant_types is enforced from here on: /authorize needs authorization_code and
-- refresh needs refresh_token. Neither was checked before, so a client that can
-- reach /authorize (it has a redirect URI) has been running both whatever its
-- row says. Record that, so enforcement changes nothing for an existing client.
-- A NULL row is first written as the column default it was always read as.
UPDATE oauth_clients SET grant_types = '{client_credentials}' WHERE grant_types IS NULL;

UPDATE oauth_clients
   SET grant_types = grant_types || ARRAY(
         SELECT g FROM unnest(ARRAY['authorization_code', 'refresh_token']::text[]) AS g
          WHERE NOT (g = ANY(grant_types)))
 WHERE cardinality(COALESCE(redirect_uris, '{}'::text[])) > 0
   AND NOT (grant_types @> ARRAY['authorization_code', 'refresh_token']::text[]);
