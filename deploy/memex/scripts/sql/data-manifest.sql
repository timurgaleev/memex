-- Data manifest: a text fingerprint of one database, for comparing two states
-- of it with a plain `diff`.
--
--   psql "$DATABASE_URL" -X -A -t -q -v ON_ERROR_STOP=1 -f data-manifest.sql > before.txt
--   ... change something ...
--   psql "$DATABASE_URL" -X -A -t -q -v ON_ERROR_STOP=1 -f data-manifest.sql > after.txt
--   diff before.txt after.txt
--
-- One tab-separated line per object, each block sorted by name:
--   server    <major version>
--   table     <name>  <rows>  <sha256 over every row, in primary-key order>
--   sequence  <name>  <last_value>  <is_called>
--   function  <name(identity arguments)>  <sha256 of its definition>
--   trigger   <table>.<name>  <sha256 of its definition>
--   columns   <table>  <sha256 of the (name, type, not null, default) list>
--
-- Covers every base table, sequence, function and trigger in schema public,
-- discovered from the catalog when it runs, so a new table is never skipped.
-- A row digest is the SHA-256 of the whole row's text form, so every column
-- counts; a table digest is the SHA-256 of its row digests, one per line.
-- Outputs from different server major versions are not comparable.
--
-- It only reads: one REPEATABLE READ, READ ONLY transaction, so every line
-- comes from the same snapshot and nothing can be written. It never runs
-- migrations and needs nothing but psql.
--
-- The generator queries end without a semicolon on purpose: `\gexec` runs the
-- query buffer, and a terminated query would run once more before it.

BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY;

-- Pin every setting that changes how a value is printed.
SET LOCAL TimeZone = 'UTC';
SET LOCAL DateStyle = 'ISO, YMD';
SET LOCAL IntervalStyle = 'postgres';
SET LOCAL extra_float_digits = 1;
SET LOCAL bytea_output = 'hex';
-- Names not visible on the search path print schema-qualified, so the caller's
-- path (PGOPTIONS, role or database defaults) must not leak into the output.
SET LOCAL search_path = public;
-- A role subject to row-level security would see an empty table and print a
-- plausible digest; with this off, such a read fails instead.
SET LOCAL row_security = off;

SELECT 'server' || E'\t' || (current_setting('server_version_num')::int / 10000)::text;

-- Tables: one generated SELECT each. Rows are ordered by the primary key
-- (a table without one by the row text), compared bytewise so the order does
-- not depend on the database collation.
SELECT format(
         $q$SELECT %L || E'\t' || count(*) || E'\t' || encode(sha256(convert_to(coalesce(string_agg(encode(sha256(convert_to(ROW(r.*)::text, 'UTF8')), 'hex') || E'\n', '' ORDER BY %s), ''), 'UTF8')), 'hex') FROM %I.%I AS r$q$,
         'table' || E'\t' || c.relname,
         coalesce(pk.cols, 'ROW(r.*)::text COLLATE "C"'),
         n.nspname,
         c.relname)
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN LATERAL (
         SELECT string_agg(
                  format('r.%I', a.attname)
                    || CASE WHEN a.attcollation <> 0 THEN ' COLLATE "C"' ELSE '' END,
                  ', ' ORDER BY k.ord) AS cols
           FROM pg_index i
          CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
          WHERE i.indrelid = c.oid AND i.indisprimary
       ) pk ON true
 WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
 ORDER BY c.relname COLLATE "C"
\gexec

SELECT format(
         $q$SELECT %L || E'\t' || last_value || E'\t' || is_called FROM %I.%I$q$,
         'sequence' || E'\t' || c.relname,
         n.nspname,
         c.relname)
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'S'
 ORDER BY c.relname COLLATE "C"
\gexec

-- An aggregate has no pg_get_functiondef; its pg_aggregate row stands in.
SELECT line FROM (
  SELECT 'function' || E'\t' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
           || E'\t' || encode(sha256(convert_to(
                CASE WHEN p.prokind = 'a'
                     THEN (SELECT ag::text FROM pg_aggregate ag WHERE ag.aggfnoid = p.oid)
                     ELSE pg_get_functiondef(p.oid)
                END, 'UTF8')), 'hex') AS line
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
) f
ORDER BY line COLLATE "C";

SELECT line FROM (
  SELECT 'trigger' || E'\t' || c.relname || '.' || t.tgname
           || E'\t' || encode(sha256(convert_to(pg_get_triggerdef(t.oid), 'UTF8')), 'hex') AS line
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND NOT t.tgisinternal
) g
ORDER BY line COLLATE "C";

SELECT line FROM (
  SELECT 'columns' || E'\t' || c.relname || E'\t' || encode(sha256(convert_to(coalesce(string_agg(
             a.attname || E'\t' || format_type(a.atttypid, a.atttypmod) || E'\t' || a.attnotnull
               || E'\t' || coalesce(pg_get_expr(d.adbin, d.adrelid), ''),
             E'\n' ORDER BY a.attnum), ''), 'UTF8')), 'hex') AS line
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
   GROUP BY c.relname
) h
ORDER BY line COLLATE "C";

COMMIT;
