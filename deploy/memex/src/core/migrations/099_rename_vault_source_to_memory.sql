-- 099_rename_vault_source_to_memory.sql — `obsidian-vault` becomes `memory`.
--
-- Migration 071 shipped the path→source mapping this project has used since:
-- `/vault/…` and `/memory/…` both route to `obsidian-vault`. That id names the
-- editor the files happened to live in, not what the source holds, and the
-- mount the vault path actually points at is `/memory` (MEMEX_VAULT_PATHS).
--
-- The mismatch is not cosmetic. Documents carry `source_path = '/vault/…'`
-- while the files sit at `/memory/…`, so an indexer pass over the configured
-- vault path inserts a duplicate document per file instead of matching the
-- existing row. Renaming the source AND rewriting the stored paths makes the
-- next pass idempotent.
--
-- `sources.id` is referenced by nine FKs, all ON UPDATE NO ACTION, so the
-- rename is insert-new → repoint children → delete-old inside one transaction
-- (the migration runner wraps each file). Idempotent: a re-run after the
-- rename finds no `obsidian-vault` row and does nothing.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM sources WHERE id = 'obsidian-vault') THEN
    RETURN;
  END IF;

  -- Carry every column over; only the id and the path prefix change.
  INSERT INTO sources (
    id, kind, path_prefix, sync_policy, indexed_policy, created_at,
    rate_limit_per_minute, respect_quiet_hours, boost_weight, description,
    chunker_version, archived, archive_expires_at, contextual_retrieval_mode,
    newest_content_at
  )
  SELECT
    'memory', kind, '/memory', sync_policy, indexed_policy, created_at,
    rate_limit_per_minute, respect_quiet_hours, boost_weight,
    'Note corpus (was obsidian-vault; renamed 2026-07-27)',
    chunker_version, archived, archive_expires_at, contextual_retrieval_mode,
    newest_content_at
  FROM sources WHERE id = 'obsidian-vault'
  ON CONFLICT (id) DO NOTHING;

  -- Repoint every table that carries a source_id. Only `documents` and
  -- `chunks` hold rows today; the rest are listed so a row that appears
  -- between now and the deploy is not orphaned by the DELETE below.
  UPDATE chunks                     SET source_id = 'memory' WHERE source_id = 'obsidian-vault';
  UPDATE documents                  SET source_id = 'memory' WHERE source_id = 'obsidian-vault';
  UPDATE code_edges_symbol          SET source_id = 'memory' WHERE source_id = 'obsidian-vault';
  UPDATE context_volunteer_events   SET source_id = 'memory' WHERE source_id = 'obsidian-vault';
  UPDATE entity_facts               SET source_id = 'memory' WHERE source_id = 'obsidian-vault';
  UPDATE ingest_log                 SET source_id = 'memory' WHERE source_id = 'obsidian-vault';
  UPDATE links                      SET source_id = 'memory' WHERE source_id = 'obsidian-vault';
  UPDATE oauth_clients              SET source_id = 'memory' WHERE source_id = 'obsidian-vault';
  UPDATE page_aliases               SET source_id = 'memory' WHERE source_id = 'obsidian-vault';
  UPDATE page_versions              SET source_id = 'memory' WHERE source_id = 'obsidian-vault';
  UPDATE pages                      SET source_id = 'memory' WHERE source_id = 'obsidian-vault';
  UPDATE slug_aliases               SET source_id = 'memory' WHERE source_id = 'obsidian-vault';
  UPDATE synth_calibration_profile  SET source_id = 'memory' WHERE source_id = 'obsidian-vault';
  UPDATE synth_contradictions       SET source_id = 'memory' WHERE source_id = 'obsidian-vault';
  UPDATE tags                       SET source_id = 'memory' WHERE source_id = 'obsidian-vault';
  UPDATE take_nudge_log             SET source_id = 'memory' WHERE source_id = 'obsidian-vault';
  UPDATE timeline_events            SET source_id = 'memory' WHERE source_id = 'obsidian-vault';

  -- The files moved from /vault to /memory; stored paths follow so the next
  -- index pass updates these documents instead of duplicating them.
  UPDATE documents
     SET source_path = '/memory/' || substring(source_path from 8)
   WHERE source_id = 'memory' AND source_path LIKE '/vault/%';

  -- PAT grants name sources as strings in a jsonb array.
  UPDATE access_tokens
     SET permissions = jsonb_set(
           permissions,
           '{source_id}',
           (SELECT jsonb_agg(CASE WHEN v = '"obsidian-vault"'::jsonb THEN '"memory"'::jsonb ELSE v END)
              FROM jsonb_array_elements(permissions->'source_id') v)
         )
   WHERE permissions ? 'source_id'
     AND permissions->'source_id' @> '"obsidian-vault"'::jsonb;

  DELETE FROM sources WHERE id = 'obsidian-vault';
END $$;
