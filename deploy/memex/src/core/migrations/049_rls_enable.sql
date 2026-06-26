-- 049_rls_enable.sql — defensive Row-Level Security enable on every data table.
--
-- This is a DEFENSE-IN-DEPTH marker, NOT the tenancy enforcement. Isolation is
-- enforced at the application layer (the `source_id` scope filter threaded
-- through every read/write handler — migration 047 + the dispatch wiring). This
-- migration only flips `relrowsecurity` on, so a future per-row policy has a
-- foundation and an accidental direct-table query by a non-privileged role
-- fails closed rather than leaking.
--
-- No policies are created here and FORCE is NOT set, so the enable is inert
-- today by design:
--   * It runs ONLY when the migrating role has BYPASSRLS (the guard below).
--     A role with BYPASSRLS is itself exempt from RLS, so enabling it changes
--     nothing for that role — the brain keeps working exactly as before.
--   * On a managed Postgres (RDS) the application/master role typically does
--     NOT hold BYPASSRLS, so the ELSE branch fires: a NOTICE is raised and no
--     table is touched. RLS stays off until an operator runs this as a
--     privileged role, at which point the enable is recorded but still has no
--     row-hiding effect without a policy.
--   * Table owners are exempt from RLS unless FORCE is set (it is not), so the
--     owning role continues to read/write freely.
--
-- PGLite-safe: PGLite exposes `pg_roles.rolbypassrls` and supports
-- `ALTER TABLE ... ENABLE ROW LEVEL SECURITY`; its default `postgres` role has
-- BYPASSRLS, so the test path enables RLS but observes no behavioural change
-- (verified: every table stays fully readable/writable under the suite).
--
-- The `migrations` bookkeeping table is intentionally excluded — the migration
-- runner reads and writes it on every boot and it carries no tenant data.
--
-- SAFETY ASSUMPTION (single-role deploy): this is only safe when the role that
-- runs migrations is the SAME role that queries at runtime (or owns the tables).
-- memex connects as one role that both migrates and serves, and that role owns
-- every table it created — owners are RLS-exempt without FORCE, so reads/writes
-- are unaffected. Do NOT grant BYPASSRLS to a dedicated migration role while the
-- app connects as a separate least-privilege, non-owner role: that would enable
-- RLS here (IF branch) while the app role has no policy → it would see zero rows
-- on every table (silent lockout). If role separation is ever introduced, add
-- permissive policies (or grant the app role BYPASSRLS) FIRST.
-- Pre-deploy check on the live instance (expect `false` on a stock RDS master):
--   SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user;
DO $$
DECLARE
  has_bypass BOOLEAN;
  tbl        TEXT;
  tables     TEXT[] := ARRAY[
    'access_tokens', 'child_done_inbox', 'chunks', 'code_edges_symbol',
    'config', 'context_volunteer_events', 'cycle_snapshots',
    'document_generation_clock', 'documents', 'embeddings', 'entities',
    'entity_facts', 'entity_mentions', 'eval_candidates', 'eval_queries',
    'friction_events', 'hot_memory', 'ingest_log', 'job_children', 'jobs',
    'links', 'mcp_request_log', 'oauth_clients', 'oauth_codes', 'oauth_tokens',
    'page_aliases', 'page_generation_clock', 'page_versions', 'pages',
    'query_cache', 'raw_data', 'recipe_state', 'source_grants', 'sources',
    'subagent_messages', 'subagent_tool_executions', 'synth_atoms',
    'synth_calibration_profile', 'synth_concept_atoms', 'synth_concepts',
    'synth_take_grades', 'synth_takes', 'tags', 'timeline_events', 'worker_lock'
  ];
BEGIN
  SELECT rolbypassrls INTO has_bypass FROM pg_roles WHERE rolname = current_user;
  IF has_bypass THEN
    FOREACH tbl IN ARRAY tables LOOP
      -- Schema-qualify to `public` on both the existence check and the ALTER so
      -- a same-named table in another schema can't be matched or mutated.
      IF EXISTS (
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = tbl AND c.relkind = 'r' AND n.nspname = 'public'
      ) THEN
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
      END IF;
    END LOOP;
    RAISE NOTICE 'RLS enabled on % data tables (role % has BYPASSRLS)',
      array_length(tables, 1), current_user;
  ELSE
    RAISE NOTICE 'Skipping RLS enable: role % lacks BYPASSRLS; isolation stays app-layer', current_user;
  END IF;
END $$;
