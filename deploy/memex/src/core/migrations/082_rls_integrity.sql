-- 082_rls_integrity.sql — DB integrity pair:
--   1. auto-RLS event trigger — every FUTURE public.* table gets ROW LEVEL
--      SECURITY enabled at CREATE time, closing the gap where a table shipped
--      after the frozen mig049 snapshot silently lacks the marker.
--   2. one-time RLS backfill over EVERY public table still lacking it — the
--      post-049 stragglers: cycle_locks (050), synth_contradictions (064),
--      slug_aliases (067), eval_snapshots (068), the 081 spend pair, and any
--      other table that landed between 049 and this migration. A catalog scan,
--      not a frozen list — 049's frozen
--      45-table snapshot is exactly the gap this closes.
--   3. UNIQUE fence key on entity_facts — the mig035 source_markdown index was
--      non-unique, so nothing in the DB enforced one live row per fence line.
--
-- Posture matches mig049, NOT a fail-loud Supabase variant:
-- memex's RLS is a defense-in-depth marker (no policies, no FORCE; isolation
-- is the app-layer source_id filter), so both the trigger install and the
-- enables are guarded + NOTICE-skipped rather than aborting a deploy on a
-- managed-Postgres role that lacks the privilege. On PGLite (superuser
-- postgres, BYPASSRLS) everything installs and nothing changes behavior;
-- on RDS the master role typically lacks BYPASSRLS and the enables skip
-- exactly as mig049's did.

-- 1. Trigger function + event trigger. object_identity is pre-quoted by
--    Postgres, so %s is correct (%I would double-quote). WHEN TAG covers all
--    three table-creating syntaxes. CREATE EVENT TRIGGER needs superuser (or
--    rds_superuser); insufficient privilege degrades to a NOTICE, and the
--    next migration run retries.
CREATE OR REPLACE FUNCTION auto_enable_rls()
RETURNS event_trigger AS $$
DECLARE
  obj record;
BEGIN
  FOR obj IN SELECT * FROM pg_event_trigger_ddl_commands()
    WHERE object_type = 'table'
    AND schema_name = 'public'
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', obj.object_identity);
  END LOOP;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  DROP EVENT TRIGGER IF EXISTS auto_rls_on_create_table;
  CREATE EVENT TRIGGER auto_rls_on_create_table
    ON ddl_command_end
    WHEN TAG IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
    EXECUTE FUNCTION auto_enable_rls();
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'Skipping auto-RLS event trigger: role % lacks the privilege', current_user;
END $$;

-- 2. One-time backfill: enable RLS on every public base table that still has
--    it off — same BYPASSRLS guard + rationale as mig049 (the single-role
--    deploy assumption documented there applies here). The `migrations`
--    bookkeeping table is excluded, as in 049.
DO $$
DECLARE
  has_bypass BOOLEAN;
  tbl        RECORD;
  enabled    INT := 0;
BEGIN
  SELECT rolbypassrls INTO has_bypass FROM pg_roles WHERE rolname = current_user;
  IF has_bypass THEN
    FOR tbl IN
      SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
        AND c.relrowsecurity = false
        AND c.relname <> 'migrations'
    LOOP
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl.relname);
      enabled := enabled + 1;
    END LOOP;
    RAISE NOTICE 'RLS enabled on % post-049 tables (role % has BYPASSRLS)',
      enabled, current_user;
  ELSE
    RAISE NOTICE 'Skipping RLS enable: role % lacks BYPASSRLS; isolation stays app-layer', current_user;
  END IF;
END $$;

-- 3. Unique fence key. The reconcile pass wipes-and-reinserts a page's LIVE
--    fence rows but PRESERVES tombstones (mig043/062) with their row_num, and
--    a superseded fence claim legitimately re-enters — so the uniqueness
--    contract is one LIVE row per (source, page, fence line). The
--    forgotten_at IS NULL arm keeps preserved tombstones out of the key
--    (memex preserves tombstones through the reconcile).
--    Pre-clean any live duplicates first (keep the oldest row).
DELETE FROM entity_facts a
 USING entity_facts b
 WHERE a.row_num IS NOT NULL AND b.row_num IS NOT NULL
   AND a.forgotten_at IS NULL AND b.forgotten_at IS NULL
   AND a.source_markdown_slug IS NOT NULL
   AND a.source_markdown_slug = b.source_markdown_slug
   AND a.source_id = b.source_id
   AND a.row_num = b.row_num
   AND a.id > b.id;

CREATE UNIQUE INDEX IF NOT EXISTS entity_facts_fence_key
  ON entity_facts (source_id, source_markdown_slug, row_num)
  WHERE row_num IS NOT NULL AND forgotten_at IS NULL;
