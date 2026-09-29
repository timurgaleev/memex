-- 026_query_cache.sql — exact-match query cache for hybrid search.
--
-- Keyed on a hash of the normalized query + k + source scope + rerank knob,
-- and stamped with the live-model `document_generation_clock` value at write
-- time. A read is valid only when the cache row's `clock_value` equals the
-- current clock — so any document write (which bumps the clock, migration
-- 025) transparently invalidates the whole cache. Stale rows are harmless
-- (never read) and can be GC'd later.
--
-- `result_ids` is the ordered list of chunk ids the ranking pipeline
-- produced; on a hit they are re-hydrated from the live tables (so returned
-- content is always current) and returned in cached order. The cache is a
-- pure optimization: callers fail open to a normal search on any cache
-- error.

CREATE TABLE IF NOT EXISTS query_cache (
  cache_key    TEXT PRIMARY KEY,
  query        TEXT NOT NULL,
  k            INTEGER NOT NULL,
  intent       TEXT,
  result_ids   JSONB NOT NULL DEFAULT '[]'::jsonb,
  clock_value  BIGINT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS query_cache_clock_idx ON query_cache(clock_value);
