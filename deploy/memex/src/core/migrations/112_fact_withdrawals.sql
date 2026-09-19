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
-- LOCK ORDER: fact row locks first, this lock after (src/core/fact-withdrawals.ts
-- holds the full rule). Because the duplicate sweep has to run both before the
-- lock and again under it, that order cannot be made a total one, so a forget
-- racing a merge or a fence rebuild can still deadlock; every writer that takes
-- this lock re-runs its transaction when Postgres names it the victim.
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
--
-- Live rows are left alone. Before this migration, re-adding a forgotten claim
-- was the only way to take a forget back, so a claim with a live copy today may
-- be a deliberate re-assertion; it is not withdrawn, and a later forget_fact on
-- it withdraws it and retires every copy. The NOTICE reports how many claims
-- were skipped that way; list them with:
--   SELECT DISTINCT f.source_id, f.visibility, f.entity_slug, f.fact
--     FROM entity_facts f
--    WHERE f.forgotten_at IS NULL AND f.dimension IS NULL
--      AND EXISTS (SELECT 1 FROM entity_facts t
--                   WHERE t.forgotten_at IS NOT NULL
--                     AND (t.forgotten_cause IS NULL OR t.forgotten_cause = 'forget')
--                     AND t.dimension IS NULL
--                     AND t.source_id = f.source_id AND t.visibility = f.visibility
--                     AND t.entity_slug = f.entity_slug
--                     AND memex_fact_claim_key(t.fact) = memex_fact_claim_key(f.fact));
DO $mig$
DECLARE
  withdrawn INT;
  kept_live INT;
BEGIN
  WITH forgotten AS (
    SELECT source_id, visibility, entity_slug,
           memex_fact_claim_key(fact) AS claim_key, MIN(id) AS first_fact_id
      FROM entity_facts
     WHERE forgotten_at IS NOT NULL
       AND (forgotten_cause IS NULL OR forgotten_cause = 'forget')
       AND dimension IS NULL
     GROUP BY 1, 2, 3, 4
  ), live AS (
    SELECT DISTINCT source_id, visibility, entity_slug,
           memex_fact_claim_key(fact) AS claim_key
      FROM entity_facts
     WHERE forgotten_at IS NULL
       AND dimension IS NULL
       AND entity_slug IN (SELECT entity_slug FROM forgotten)
  ), kept AS (
    SELECT COUNT(*)::int AS n
      FROM forgotten f JOIN live l USING (source_id, visibility, entity_slug, claim_key)
  ), ins AS (
    INSERT INTO fact_withdrawals (source_id, visibility, entity_slug, claim_key, first_fact_id, reason)
    SELECT f.source_id, f.visibility, f.entity_slug, f.claim_key, f.first_fact_id, 'backfill'
      FROM forgotten f
     WHERE NOT EXISTS (
       SELECT 1 FROM live l
        WHERE l.source_id = f.source_id AND l.visibility = f.visibility
          AND l.entity_slug = f.entity_slug AND l.claim_key = f.claim_key)
    ON CONFLICT DO NOTHING
    RETURNING 1
  )
  SELECT (SELECT COUNT(*)::int FROM ins), (SELECT n FROM kept)
    INTO withdrawn, kept_live;
  IF withdrawn > 0 OR kept_live > 0 THEN
    RAISE NOTICE '112: withdrew % forgotten claim(s); left % claim(s) with a live copy unwithdrawn',
      withdrawn, kept_live;
  END IF;
END
$mig$;
