-- memex schema migration 113: admit the `github` source kind.
--
-- `memex connectors github sync` mirrors a repository's issues and pull
-- requests into one named source, and refuses a source of any other kind so a
-- connector run can never land pages in a vault or a tenant's notes by a typo.
-- Same replace-the-CHECK pattern as migration 012.

ALTER TABLE sources
  DROP CONSTRAINT IF EXISTS sources_kind_check;
ALTER TABLE sources
  ADD CONSTRAINT sources_kind_check
    CHECK (kind IN (
      'vault',
      'memory',
      'webhook',
      'mailbox',
      'calendar',
      'transcript',
      'code',
      'github',
      'other'
    ));
