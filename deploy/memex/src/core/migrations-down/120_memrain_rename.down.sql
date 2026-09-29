-- 120_memrain_rename.down.sql — undo migration 120 inside the upgrade window.
--
-- Run it in ONE transaction, with every app process stopped:
--   bun run src/cli.ts apply-migrations --down 120 --yes
--   psql "$URL" -v ON_ERROR_STOP=1 -1 -f 120_memrain_rename.down.sql
--
-- 120 wrote no data, so this touches no row either: it re-points the trigger
-- at the untouched 116 function, drops the two functions 120 added and removes
-- 120's migrations row. It refuses, and changes nothing, unless 120 is the
-- latest migration, no other client is connected to this database, and no page
-- carries a memrain fence. Such a fence means the new release already wrote
-- page data, which the old release would read as a page without a fence.

SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('memrain:migrations'));

DO $down$
BEGIN
  IF (SELECT max(id) FROM migrations) IS DISTINCT FROM 120 THEN
    RAISE EXCEPTION '120 down: migration 120 is not the latest applied migration';
  END IF;
  IF (SELECT count(*) FROM pg_stat_activity
       WHERE datname = current_database()
         AND backend_type = 'client backend'
         AND pid <> pg_backend_pid()) > 0 THEN
    RAISE EXCEPTION '120 down: other client sessions are connected; stop every app process first';
  END IF;
  IF EXISTS (SELECT 1 FROM pages
              WHERE strpos(markdown_body, '<!--- memrain:facts:begin -->') > 0
                 OR strpos(markdown_body, '<!--- memrain:takes:begin -->') > 0) THEN
    RAISE EXCEPTION '120 down: a page carries a memrain fence; the new release already wrote page data';
  END IF;
END
$down$;

DROP TRIGGER IF EXISTS entity_facts_withdrawn_on_insert ON entity_facts;
CREATE TRIGGER entity_facts_withdrawn_on_insert
  BEFORE INSERT ON entity_facts
  FOR EACH ROW
  WHEN (NEW.forgotten_at IS NULL AND NEW.dimension IS NULL)
  EXECUTE FUNCTION memex_fact_withdrawn_on_insert();

DROP FUNCTION memrain_fact_withdrawn_on_insert();
DROP FUNCTION memrain_fact_claim_key(text);

DELETE FROM migrations WHERE id = 120;
