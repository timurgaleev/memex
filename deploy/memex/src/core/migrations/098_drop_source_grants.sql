-- 098_drop_source_grants.sql — retire the JWT-subject grant store.
--
-- The brain serves exactly one person. `source_grants` (migration 048) was
-- the server-side entitlement floor for the external-IdP (JWT `sub`) tenancy
-- path; that path was never wired into ingress — the live OAuth path reads
-- its grant off `oauth_clients.source_id`/`federated_read`, and PATs carry
-- `access_tokens.permissions.source_id`. With the tenant provisioning
-- surface (CLI + admin endpoints) removed, the table has no readers or
-- writers left.
--
-- Guarded: a brain that still holds provisioned grants refuses the drop
-- instead of silently destroying them — export/remove the rows first
-- (the migration transaction rolls back, so nothing is lost).
DO $$
DECLARE
  n bigint;
BEGIN
  IF to_regclass('source_grants') IS NULL THEN
    RETURN; -- already gone (fresh install after this migration, or re-run)
  END IF;
  EXECUTE 'SELECT count(*) FROM source_grants' INTO n;
  IF n > 0 THEN
    RAISE EXCEPTION 'source_grants still holds % row(s); the single-person model drops this table — export or delete the grants first', n;
  END IF;
  EXECUTE 'DROP TABLE source_grants';
END $$;
