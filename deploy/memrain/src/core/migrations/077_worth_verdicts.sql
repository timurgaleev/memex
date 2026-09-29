-- 077: synth_worth_verdicts — cached Haiku "worth processing?" verdicts.
--
-- The paid Sonnet transcript consumers (conversation-facts backfill,
-- reflections) can pre-screen each transcript with a cheap Haiku significance
-- judge before spending Sonnet on it. The verdict is cached per
-- (source_ref, content_hash) so a re-run — and every later phase looking at the
-- same unchanged transcript — never re-pays the judge. The cache sits BEFORE
-- the spend.
--
-- source_ref is a page slug (memex transcripts are pages, not files);
-- content_hash is the 16-char body hash, so an edited transcript is re-judged.
--
-- Additive + idempotent: IF NOT EXISTS only.

CREATE TABLE IF NOT EXISTS synth_worth_verdicts (
  source_ref       TEXT NOT NULL,
  content_hash     TEXT NOT NULL,
  worth_processing BOOLEAN NOT NULL,
  reasons          JSONB NOT NULL DEFAULT '[]'::jsonb,
  model_id         TEXT NOT NULL,
  judged_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source_ref, content_hash)
);

CREATE INDEX IF NOT EXISTS synth_worth_verdicts_judged_idx
  ON synth_worth_verdicts (judged_at);
