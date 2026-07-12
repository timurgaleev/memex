-- 095_search_path_hardening.sql — pin schema resolution + widen the RLS backfill guard.
--
-- Two defense-in-depth fixes, both idempotent and body-preserving:
--
--   1. Pin `search_path` on the two SECURITY-relevant functions memex ships as
--      triggers: `chunks_update_search_vector` (the tsvector maintainer, mig
--      030/032) and `auto_enable_rls` (the event trigger that RLS-enables every
--      future public table, mig 082). A trigger function runs under the calling
--      session's `search_path`, so an unqualified reference inside it resolves
--      against whatever schemas that session put first — a writer who prepends a
--      schema of their own could shadow a built-in the body calls. Pinning
--      `pg_catalog, public` makes resolution deterministic regardless of the
--      caller's session. The bodies are untouched; only the function's attached
--      search_path setting changes. Applied via ALTER FUNCTION (the migrating
--      role owns these functions, having created them in earlier migrations).
--
--   2. Re-run mig 082's one-time RLS backfill, but with a broadened privilege
--      probe. mig 082 asked `rolbypassrls` of the current role directly; a role
--      that inherits BYPASSRLS (or SUPERUSER) through role membership rather
--      than holding the attribute on its own row was mis-read as lacking it, so
--      the backfill skipped when it could in fact have run. `pg_has_role(...,
--      'USAGE')` over every granting role closes that gap. NOTICE-skip semantics
--      are preserved: a role that genuinely lacks the privilege logs and moves
--      on rather than aborting the deploy (isolation stays the app-layer
--      source_id filter, exactly as mig 049/082 document).

-- 1. search_path hardening on the trigger / event-trigger functions.
DO $$
DECLARE
  fn TEXT;
BEGIN
  FOREACH fn IN ARRAY ARRAY['chunks_update_search_vector', 'auto_enable_rls']
  LOOP
    IF EXISTS (
      SELECT 1
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname = fn
    ) THEN
      EXECUTE format(
        'ALTER FUNCTION public.%I() SET search_path = pg_catalog, public', fn);
    END IF;
  END LOOP;
END $$;

-- 2. RLS backfill with the broadened bypass/superuser probe. Same catalog scan
--    and NOTICE-skip posture as mig 082; only the privilege test is widened to
--    honor inherited role membership. Alias `pr` avoids collision with the
--    record loop variables.
DO $$
DECLARE
  has_bypass BOOLEAN;
  tbl        RECORD;
  enabled    INT := 0;
BEGIN
  SELECT EXISTS (
    SELECT 1
      FROM pg_roles pr
     WHERE pg_has_role(current_user, pr.oid, 'USAGE')
       AND (pr.rolbypassrls OR pr.rolsuper)
  ) INTO has_bypass;
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
    RAISE NOTICE 'RLS enabled on % public table(s) (role % has bypass/superuser)',
      enabled, current_user;
  ELSE
    RAISE NOTICE 'Skipping RLS enable: role % lacks BYPASSRLS/superuser; isolation stays app-layer', current_user;
  END IF;
END $$;
