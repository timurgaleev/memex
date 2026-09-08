-- 101_per_grant_source.sql — move the tenant binding from the CLIENT row to the
-- individual GRANT.
--
-- Why: a corporate chat vendor publishes a connector once for a whole
-- organisation, and every member authorises against that single connector. With
-- the source pinned to `oauth_clients.source_id`, one connector can only ever be
-- one tenant — so serving N people meant registering N connectors, each visible
-- in the shared catalog to everyone in the company. Binding the source to the
-- authorization instead lets ONE connector serve many people, each pinned to
-- their own source by the operator at approval time.
--
-- NULL means "not set" and the client row still decides, which is what every
-- existing code and token carries — so this migration changes no behavior on
-- its own.
--
-- Deliberately NOT a foreign key to `sources`. With a FK plus ON DELETE SET
-- NULL, deleting a source would silently widen every token that named it back
-- to the client's scope; with ON DELETE CASCADE it would delete grant rows out
-- from under live sessions. Instead the source is validated when the grant is
-- issued, and a source that still has grants must not be deleted.
ALTER TABLE oauth_codes  ADD COLUMN IF NOT EXISTS source_id      TEXT;
ALTER TABLE oauth_codes  ADD COLUMN IF NOT EXISTS federated_read TEXT[];
ALTER TABLE oauth_tokens ADD COLUMN IF NOT EXISTS source_id      TEXT;
ALTER TABLE oauth_tokens ADD COLUMN IF NOT EXISTS federated_read TEXT[];

-- Presence marker. Without it a grant that deliberately pins a session to NO
-- source is indistinguishable from a legacy row that predates this migration,
-- and the client-row fallback would WIDEN it. `grant_bound = TRUE` means the
-- grant columns on THIS row are authoritative even when they are NULL.
ALTER TABLE oauth_codes  ADD COLUMN IF NOT EXISTS grant_bound BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE oauth_tokens ADD COLUMN IF NOT EXISTS grant_bound BOOLEAN NOT NULL DEFAULT FALSE;

-- Answers "which grants still name this source?" before a source is dropped,
-- and "who is pinned where?" for the operator's own review.
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_source ON oauth_tokens (source_id)
  WHERE source_id IS NOT NULL;
