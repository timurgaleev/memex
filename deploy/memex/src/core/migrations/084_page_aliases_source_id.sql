-- 084_page_aliases_source_id.sql — tenant-scope the declared free-text alias
-- index (adds page_aliases.source_id).
--
-- WHY: page_aliases (mig034) is keyed (alias_norm, slug) with NO tenancy
-- column. Scoped resolution today rides a JOIN onto pages.source_id, which
-- works but (a) leaves the index itself brain-global — an unscoped consumer
-- reading page_aliases directly sees every tenant's declared names (an
-- existence leak), and (b) makes the alias row's ownership implicit, so a
-- page whose source ever changes silently re-tenants its aliases. Stamping
-- source_id on the row makes ownership explicit and lets resolvers filter
-- the alias table directly, like slug_aliases (mig067) already does.
--
-- Backfill: every alias row inherits its page's source_id; a dangling row
-- (page deleted between mig034's CASCADE and now — shouldn't exist) falls
-- back to 'default'. NOT NULL DEFAULT 'default' matches the mig047 idiom.
--
-- Key widening: PK (alias_norm, slug) → (alias_norm, source_id, slug).
-- alias_norm stays the LEADING column (deliberate) because memex resolvers
-- look up by alias first and are only sometimes scoped — a leading alias_norm
-- serves both the scoped and the unscoped (operator, whole-brain) probe. Appending
-- columns to a key that was already unique cannot introduce duplicates, so
-- the swap is collision-safe on live data.

ALTER TABLE page_aliases ADD COLUMN IF NOT EXISTS source_id TEXT;

UPDATE page_aliases pa
   SET source_id = p.source_id
  FROM pages p
 WHERE p.slug = pa.slug
   AND pa.source_id IS NULL;

UPDATE page_aliases SET source_id = 'default' WHERE source_id IS NULL;

ALTER TABLE page_aliases ALTER COLUMN source_id SET DEFAULT 'default';
ALTER TABLE page_aliases ALTER COLUMN source_id SET NOT NULL;

-- Widen the PK, guarded on arity so a re-run is a no-op (Postgres has no
-- ADD CONSTRAINT IF NOT EXISTS; the mig029/037 catalog-guard idiom).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'page_aliases_pkey'
       AND conrelid = 'page_aliases'::regclass
       AND array_length(conkey, 1) = 3
  ) THEN
    ALTER TABLE page_aliases DROP CONSTRAINT IF EXISTS page_aliases_pkey;
    ALTER TABLE page_aliases
      ADD CONSTRAINT page_aliases_pkey
      PRIMARY KEY (alias_norm, source_id, slug);
  END IF;
END $$;

-- The per-page replace (`DELETE ... WHERE slug`) keeps its mig034 index;
-- nothing else needed — the new PK's leading column serves alias lookups.
