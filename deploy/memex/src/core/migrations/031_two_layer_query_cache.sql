-- 031_two_layer_query_cache.sql — per-document generation + cache snapshot.
--
-- Migration 025 gave the live model a single global clock
-- (document_generation_clock). The exact-match query cache (026) gates on
-- it: a row is valid iff its stored clock equals the current clock, so ANY
-- document write invalidates the WHOLE cache. Correct, but coarse — a one-doc
-- edit evicts every cached query, even ones that never touched that doc.
--
-- This adds the substrate for a two-layer gate (see core/search/query-cache.ts):
--
--   Layer 1 (cheap bookmark) — unchanged: stored clock == current clock means
--     nothing wrote since this row stored, so it is fresh corpus-wide. The
--     clock is monotonic, so the existing `clock_value = current` check is the
--     bookmark; no SQL change to Layer 1.
--
--   Layer 2 (per-document snapshot) — NEW: when the bookmark fails (some write
--     happened), fall through to a per-document check. `documents.generation`
--     is bumped only for the document actually re-written (indexer-tx folds
--     `generation = generation + 1` into its UPSERT). The cache row records the
--     generation of every document its result chunks belong to, in
--     `query_cache.doc_generations` ({document_id: generation}). On read, the
--     row still serves iff every recorded document still exists AND its
--     generation is unchanged — so a write to an UNRELATED document no longer
--     evicts this query.
--
-- Accepted tradeoff: a brand-NEW document
-- that would now rank into an already-cached query does NOT invalidate that
-- row (its referenced docs are unchanged), so the cache can serve a result
-- missing the new doc until one of its referenced docs changes or the row is
-- pruned. This trades a bounded staleness window for a higher hit rate; the
-- old global-clock gate over-invalidated to avoid it. Acceptable for a
-- low-write personal brain; the corpus-wide writers that need a hard flush
-- (e.g. embedding backfill) call clearCache() explicitly.
--
-- Backward compat: existing query_cache rows default doc_generations to '{}'.
-- An empty snapshot CANNOT disprove staleness, so it is treated as Layer-1-only
-- (it never passes Layer 2) — legacy rows invalidate on the first post-write
-- lookup, then refill with real snapshots. Existing documents default
-- generation to 0; the next re-index bumps them.
--
-- No DB trigger (memex convention — callers bump counters inside their own
-- write transaction; see core/generation.ts).

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS generation BIGINT NOT NULL DEFAULT 0;

ALTER TABLE query_cache
  ADD COLUMN IF NOT EXISTS doc_generations JSONB NOT NULL DEFAULT '{}'::jsonb;
