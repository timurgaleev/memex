-- 105_documents_source_id_index.sql — index documents.source_id.
--
-- Migration 004 meant to create this index, but it reused the name
-- `documents_source_idx`, which 001 had already taken for `documents(source_path)`;
-- `CREATE INDEX IF NOT EXISTS` then did nothing and said nothing. Every
-- source-scoped read has been sequentially scanning the table since.
--
-- The partial index serves the sweeps' classification pass, which looks only for
-- the unclassified rows.

CREATE INDEX IF NOT EXISTS documents_source_id_idx
  ON documents (source_id);

CREATE INDEX IF NOT EXISTS documents_source_id_null_idx
  ON documents (source_path) WHERE source_id IS NULL;

-- Migration 058's chunk index is partial on `source_id IS NOT NULL`, the
-- opposite of what the classification pass looks for, so its chunk statement
-- scanned every chunk row on every sweep tick — work that grows with the corpus
-- while the sweep's real work shrinks to nothing.
CREATE INDEX IF NOT EXISTS chunks_source_id_null_idx
  ON chunks (document_id) WHERE source_id IS NULL;
