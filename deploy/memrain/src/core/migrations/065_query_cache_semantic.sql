-- 065_query_cache_semantic.sql — semantic (embedding-cosine) query-cache arm.
--
-- The exact-match cache (026) keys on a sha256 of the normalized query text, so
-- a paraphrase ("who leads Acme" vs "who is Acme's CEO") always misses even when
-- the ranking would be identical. This adds an OPTIONAL semantic arm: store the
-- query embedding per cache row, and on an exact miss match the nearest stored
-- query embedding by cosine similarity, bounded to the SAME scope/knobs bucket,
-- a freshness gate, and a TTL.
--
--   query_embedding — the query's Titan vector (same width as embeddings, 1024).
--     NULL when the semantic arm was off at write time, or when the vector arm
--     was degraded (embed failed) — such rows are exact-match only.
--
--   bucket_key — sha256 of every ranking input EXCEPT the query text (k, source
--     scope, rerank, ranking signature). A semantic match must land in the same
--     bucket, so a paraphrase can only borrow a ranking computed under identical
--     knobs. The exact-match `cache_key` still encodes the query, so it cannot
--     serve this role.
--
-- Additive + safe: both columns are nullable and default NULL. The exact-match
-- path is unchanged (it never reads these). The semantic arm is off unless
-- MEMEX_QUERY_CACHE_SEMANTIC=1, and even then it only ADDS hits — it never
-- weakens the existing two-layer freshness gate (generation clock + per-doc
-- snapshot), which the semantic read re-applies on top of the TTL.

ALTER TABLE query_cache
  ADD COLUMN IF NOT EXISTS query_embedding vector(1024);

ALTER TABLE query_cache
  ADD COLUMN IF NOT EXISTS bucket_key TEXT;

-- The semantic probe filters `bucket_key = $` before the cosine scan, so index
-- the bucket over the stamped rows only (NULL bucket rows are exact-match only).
CREATE INDEX IF NOT EXISTS query_cache_bucket_idx
  ON query_cache(bucket_key)
  WHERE bucket_key IS NOT NULL;
