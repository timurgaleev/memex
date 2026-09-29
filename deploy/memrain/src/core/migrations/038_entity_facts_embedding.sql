-- 038_entity_facts_embedding.sql -- semantic embedding for facts.
--
-- Adds a NULLABLE 1024-dim `embedding` column to entity_facts so a fact's text
-- can be ranked by SEMANTIC similarity to a query (e.g. "what do I know about
-- Alice's funding?"), not just by confidence/recency. The vector is produced by
-- the same Bedrock Titan v2 path the chunk embeddings use (1024 dims), populated
-- by the `embed-facts` cycle phase (falls-open: a Bedrock outage leaves the
-- column NULL and the fact still recalls by the legacy confidence order).
--
-- NULLABLE + additive (ADD COLUMN IF NOT EXISTS) -- no backfill at migrate time,
-- no behavior change for existing rows; the cycle phase backfills incrementally.
--
-- No ANN index: entity_recall filters by `entity_slug` FIRST (a small per-entity
-- row set), then orders by cosine distance over that subset -- an exact scan of
-- a few dozen rows is cheaper than maintaining an HNSW/ivfflat index over the
-- whole ledger. Add an index only if a cross-entity fact search lands.
--
-- The `vector` type + `<=>` cosine operator are already in use by the
-- `embeddings` table (migration 001), so no new extension is needed here.

ALTER TABLE entity_facts
  ADD COLUMN IF NOT EXISTS embedding vector(1024);
