-- memex initial schema.
-- Tables that -3 work fills with content.
--
-- The `migrations` bookkeeping table is bootstrapped separately by the
-- migration engine (it must exist BEFORE any migration runs), so it does
-- NOT live in this file.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  source_path TEXT NOT NULL,
  title TEXT,
  frontmatter JSONB DEFAULT '{}'::jsonb,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS documents_source_idx ON documents(source_path);

CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  ts tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED
);

CREATE INDEX IF NOT EXISTS chunks_document_idx ON chunks(document_id);
CREATE INDEX IF NOT EXISTS chunks_ts_idx ON chunks USING GIN(ts);

CREATE TABLE IF NOT EXISTS embeddings (
  chunk_id TEXT PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
  vector vector(1024) NOT NULL,
  model TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- HNSW index for cosine-similarity search (built lazily — empty in ).
CREATE INDEX IF NOT EXISTS embeddings_vector_idx ON embeddings
  USING hnsw (vector vector_cosine_ops);
