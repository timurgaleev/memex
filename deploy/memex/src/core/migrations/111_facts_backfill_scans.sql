-- 111_facts_backfill_scans.sql — durable zero-yield memo for the
-- conversation-facts backfill.
--
-- The backfill treats "has a facts-extract fact row" as done. A page whose paid
-- extraction read cleanly but yielded nothing new has no such row, so every run
-- paid Sonnet for it again. One row here records that clean empty outcome.
--
-- The key carries source_id to match the backfill's (slug, source_id) fact
-- marker: a memo written while one source owned the slug never hides the page
-- once another source owns it. It carries
-- content_hash so an edited transcript is scanned again, and extractor_version
-- so a prompt or schema change re-opens every memoized page. No FK to pages: a
-- purged page's memo is harmless, and a changed body never matches it.
-- Unreadable outcomes (malformed, truncated, budget, model errors) are never
-- written here; they stay retryable.
CREATE TABLE IF NOT EXISTS facts_backfill_scans (
  source_id          TEXT NOT NULL,
  slug               TEXT NOT NULL,
  content_hash       TEXT NOT NULL,
  extractor_version  TEXT NOT NULL,
  outcome            TEXT NOT NULL CHECK (outcome IN ('zero_yield')),
  facts_skipped      INTEGER NOT NULL DEFAULT 0,
  model_id           TEXT,
  scanned_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, slug, content_hash, extractor_version)
);
