-- 120_memrain_rename.sql — the claim-key and withdrawal-trigger functions under
-- their memrain_ names.
--
-- Only new objects are created: the memex_ functions of 112/116 keep their text,
-- and the trigger is re-pointed at the new function. No row in any table is
-- inserted, updated or deleted here, so the down file in migrations-down/ only
-- has to drop what this adds.
--
-- memex_fact_claim_key(text) and memex_fact_withdrawn_on_insert() stay for
-- binaries built before the rename; the second one is left detached.

-- The body is 112's, byte for byte. Only search_path is pinned in addition; the
-- body calls pg_catalog functions alone, so the result is the same.
CREATE OR REPLACE FUNCTION memrain_fact_claim_key(claim TEXT)
RETURNS TEXT
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
SET search_path = pg_catalog, public AS $fn$
  SELECT md5(lower(btrim(regexp_replace(claim, '\s+', ' ', 'g'))))
$fn$;

-- 116's body with the claim-key function renamed and nothing else changed. The
-- lock namespace is deliberately the old one: it pairs with the exclusive lock
-- every writer that retires withdrawn claims takes, pre-rename ones included.
CREATE OR REPLACE FUNCTION memrain_fact_withdrawn_on_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public AS $fn$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext('memex:fact-withdraw:' || NEW.source_id));
  IF EXISTS (
    SELECT 1 FROM fact_withdrawals
     WHERE source_id = NEW.source_id
       AND visibility = NEW.visibility
       AND entity_slug = NEW.entity_slug
       AND claim_key = memrain_fact_claim_key(NEW.fact)
  ) THEN
    NEW.forgotten_at := now();
    NEW.forgotten_cause := 'forget';
    NEW.forgotten_reason := 'withdrawn';
  END IF;
  RETURN NEW;
END;
$fn$;

-- Transactional DDL: other sessions never see the table without the trigger.
DROP TRIGGER IF EXISTS entity_facts_withdrawn_on_insert ON entity_facts;
CREATE TRIGGER entity_facts_withdrawn_on_insert
  BEFORE INSERT ON entity_facts
  FOR EACH ROW
  WHEN (NEW.forgotten_at IS NULL AND NEW.dimension IS NULL)
  EXECUTE FUNCTION memrain_fact_withdrawn_on_insert();
