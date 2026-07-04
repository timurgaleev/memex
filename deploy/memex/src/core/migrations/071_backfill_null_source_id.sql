-- 071: backfill NULL source_id on documents + chunks by ingest path.
--
-- Content ingested before the source_id stamping (mig047 documents / mig058
-- chunks) kept a NULL source_id and was never backfilled. A scoped read filters
-- `source_id = ANY(<federated_read>)`, and NULL matches nothing — so those rows
-- are INVISIBLE to any scoped (per-tenant / OAuth) reader, even though they are
-- the operator's own notes. This stamps them from their document path so they
-- rejoin the world they belong to. Idempotent: only ever touches NULL rows.
--
-- Path -> source mapping (matches the live ingest recipes):
--   /vault/… , /memory/…   -> obsidian-vault   (the Obsidian vault mount)
--   /repo-source/…         -> repo-source-code  (the code corpus)
--   anything else          -> default           (manual / agent-authored)

UPDATE documents
   SET source_id = 'obsidian-vault'
 WHERE source_id IS NULL
   AND (source_path LIKE '/vault/%' OR source_path LIKE '/memory/%');

UPDATE documents
   SET source_id = 'repo-source-code'
 WHERE source_id IS NULL
   AND source_path LIKE '/repo-source/%';

UPDATE documents
   SET source_id = 'default'
 WHERE source_id IS NULL;

-- Chunks inherit their document's (now-backfilled) source_id.
UPDATE chunks c
   SET source_id = d.source_id
  FROM documents d
 WHERE c.document_id = d.id
   AND c.source_id IS NULL;
