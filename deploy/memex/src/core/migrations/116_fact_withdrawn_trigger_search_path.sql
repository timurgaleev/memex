-- Pin the withdrawal trigger's search_path.
--
-- Migration 112 created memex_fact_withdrawn_on_insert() without SET
-- search_path, so on a brain that already applied 112 the function still
-- resolves fact_withdrawals through the caller's search_path. 095 hardened
-- every function that existed then; this does the same for this one, by
-- redefining it exactly as 112 now spells it.

CREATE OR REPLACE FUNCTION memex_fact_withdrawn_on_insert()
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
       AND claim_key = memex_fact_claim_key(NEW.fact)
  ) THEN
    NEW.forgotten_at := now();
    NEW.forgotten_cause := 'forget';
    NEW.forgotten_reason := 'withdrawn';
  END IF;
  RETURN NEW;
END;
$fn$;
