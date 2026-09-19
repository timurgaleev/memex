-- 112_fact_withdrawals.sql — a forgotten claim stays forgotten.
--
-- A forget used to live only on the one row it flipped. The same claim came
-- back as a fresh live row the next time anything re-asserted it: another page's
-- extraction, a transcript import, an agent's add_fact. Only a fence rebuild of
-- the SAME page honored the tombstone.
--
-- `fact_withdrawals` records the forget as a claim, not a row. The key is
-- (source_id, visibility, entity_slug, claim_key):
--   - source_id and visibility: a tenant's forget never reaches another tenant,
--     and a private forget says nothing about a published claim;
--   - entity_slug: a short claim ("works remotely") forgotten about one subject
--     stays true of another;
--   - claim_key: memex_fact_claim_key(fact), so a whitespace or case restatement
--     is the same claim.
--
-- A BEFORE INSERT trigger stamps any matching insert as forgotten, whichever
-- write path produced it. Inserts take the per-source lock SHARED, so they never
-- serialize against each other; a forget takes it EXCLUSIVE, so an insert that
-- raced past the ledger check has committed before the forget's duplicate sweep
-- runs, and the sweep sees it.
--
-- Dimensional ontology rows (dimension IS NOT NULL) have their own lifecycle and
-- are out of scope. Supersede and consolidate retirements are not forgets and
-- record nothing.

-- The one normalization of a claim, used by SQL and TS alike (TS always calls it
-- through SQL). `\s+` is a single-class run, linear in the input.
CREATE OR REPLACE FUNCTION memex_fact_claim_key(claim TEXT)
RETURNS TEXT
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $fn$
  SELECT md5(lower(btrim(regexp_replace(claim, '\s+', ' ', 'g'))))
$fn$;

CREATE TABLE IF NOT EXISTS fact_withdrawals (
  source_id      TEXT NOT NULL,
  visibility     TEXT NOT NULL,
  entity_slug    TEXT NOT NULL,
  claim_key      TEXT NOT NULL,
  first_fact_id  BIGINT,
  reason         TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, visibility, entity_slug, claim_key)
);

CREATE OR REPLACE FUNCTION memex_fact_withdrawn_on_insert()
RETURNS trigger
LANGUAGE plpgsql AS $fn$
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

DROP TRIGGER IF EXISTS entity_facts_withdrawn_on_insert ON entity_facts;
CREATE TRIGGER entity_facts_withdrawn_on_insert
  BEFORE INSERT ON entity_facts
  FOR EACH ROW
  WHEN (NEW.forgotten_at IS NULL AND NEW.dimension IS NULL)
  EXECUTE FUNCTION memex_fact_withdrawn_on_insert();

-- Backfill from the forgets already on file. A NULL cause is a pre-062 row, and
-- every tombstone of that era came from forget_fact.
INSERT INTO fact_withdrawals (source_id, visibility, entity_slug, claim_key, first_fact_id, reason)
SELECT source_id, visibility, entity_slug, memex_fact_claim_key(fact), MIN(id), 'backfill'
  FROM entity_facts
 WHERE forgotten_at IS NOT NULL
   AND (forgotten_cause IS NULL OR forgotten_cause = 'forget')
   AND dimension IS NULL
 GROUP BY source_id, visibility, entity_slug, memex_fact_claim_key(fact)
ON CONFLICT DO NOTHING;

-- Retire the copies that came back after their claim was forgotten. A re-run
-- finds none left.
UPDATE entity_facts ef
   SET forgotten_at = now(),
       forgotten_cause = 'forget',
       forgotten_reason = 'withdrawn (backfill)'
  FROM fact_withdrawals w
 WHERE ef.forgotten_at IS NULL
   AND ef.dimension IS NULL
   AND ef.source_id = w.source_id
   AND ef.visibility = w.visibility
   AND ef.entity_slug = w.entity_slug
   AND memex_fact_claim_key(ef.fact) = w.claim_key;
