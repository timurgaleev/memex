-- 106_chunks_contextual_tier.sql — record which contextual tier produced a
-- chunk's stored vector.
--
-- Migration 057's `contextual_embedded` marker is set only by
-- `reindex --contextual`; the indexer never set it, so every chunk a live write
-- wrapped — deterministic prefix or a paid Haiku blurb — read as un-wrapped. A
-- later `reindex --contextual` then paid to redo those chunks, and with the LLM
-- tier off it overwrote Haiku-situated vectors with deterministic ones. The tier
-- is what a re-embed has to respect, so it is recorded per chunk:
--   none           embedded raw (code, fenced-code symbols, wrapping off)
--   deterministic  embedded under the <context>title + synopsis</context> prefix
--   llm            embedded under a Haiku-generated situating blurb
-- NULL means unknown: chunks written before this migration. Nothing is guessed
-- for them. Additive; the CHECK only constrains new values.
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS contextual_tier TEXT
  CHECK (contextual_tier IS NULL OR contextual_tier IN ('none', 'deterministic', 'llm'));
