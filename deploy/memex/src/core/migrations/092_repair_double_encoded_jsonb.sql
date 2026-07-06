-- 092: repair double-encoded jsonb values (the postgres.js $N::jsonb bug).
--
-- Binding a pre-stringified JSON string to a bare `$N::jsonb` position via
-- postgres.js `unsafe(sql, params)` double-encodes: the text->jsonb cast wraps
-- the already-JSON text into a jsonb *string scalar* ('"{\"a\":1}"' instead of
-- '{"a":1}'). PGLite hid the bug; real Postgres exposed it live
-- (access_tokens.permissions, fixed v1.80.1 by binding objects). The write
-- paths now either bind raw objects or cast `$N::text::jsonb`; this repairs
-- the rows the buggy casts already wrote.
--
-- Shape: an information_schema scan over EVERY public jsonb column — a frozen
-- column list would miss exactly the stragglers this exists for. Per column,
-- rewrite rows where the value is a jsonb string scalar whose contained text
-- parses as JSON *AND the parsed value is an object or array*: SET col =
-- (col #>> '{}')::jsonb. The object/array guard is deliberate — the
-- double-encode bug ONLY ever wrapped JSON.stringify of objects/arrays, so a
-- legitimate string scalar that happens to contain a JSON scalar literal
-- (e.g. '"123"', '"true"', '"null"') is NOT a double-encode artifact and must
-- be left alone rather than silently retyped to number/boolean/null. String
-- scalars whose text is not valid JSON are already skipped by the try-parse;
-- a per-column exception guard skips (NOTICE, never abort) any column whose
-- rewrite still fails. Idempotent: a repaired value is no longer a string
-- scalar, so a re-run matches zero rows.

-- Per-row try-parse: jsonb on success, SQL NULL on any parse failure. Dropped
-- at the end of the migration — repair-scoped, not a durable helper.
CREATE OR REPLACE FUNCTION mx_092_try_jsonb(t text) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE AS $fn$
BEGIN
  RETURN t::jsonb;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$fn$;

DO $$
DECLARE
  col record;
  repaired bigint;
BEGIN
  FOR col IN
    SELECT c.table_name, c.column_name
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema
       AND t.table_name = c.table_name
     WHERE c.table_schema = 'public'
       AND c.data_type = 'jsonb'
       AND t.table_type = 'BASE TABLE'
     ORDER BY c.table_name, c.column_name
  LOOP
    BEGIN
      EXECUTE format(
        'UPDATE %I SET %I = mx_092_try_jsonb(%I #>> ''{}'')
          WHERE jsonb_typeof(%I) = ''string''
            AND mx_092_try_jsonb(%I #>> ''{}'') IS NOT NULL
            AND jsonb_typeof(mx_092_try_jsonb(%I #>> ''{}'')) IN (''object'', ''array'')',
        col.table_name, col.column_name, col.column_name,
        col.column_name, col.column_name, col.column_name);
      GET DIAGNOSTICS repaired = ROW_COUNT;
      IF repaired > 0 THEN
        RAISE NOTICE '092: repaired % double-encoded row(s) in %.%',
          repaired, col.table_name, col.column_name;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      -- Skip, never abort: a column whose rewrite fails wholesale (e.g. a
      -- CHECK constraint rejecting the parsed shape) is left for manual
      -- repair rather than blocking the deploy.
      RAISE NOTICE '092: skipped %.% (%)',
        col.table_name, col.column_name, SQLERRM;
    END;
  END LOOP;
END $$;

DROP FUNCTION mx_092_try_jsonb(text);
