-- 063_synth_takes_embedding_lifecycle.sql — take retrieval + lifecycle hygiene.
--
-- Two additive, idempotent changes to synth_takes (migration 045):
--
--  1. `embedding vector(1024)` — a nullable Titan-v2 embedding of the claim so
--     `think` GATHER can run a VECTOR stream over takes (cosine over the claim
--     text), fused with the existing keyword stream. NULLABLE + additive: no
--     backfill at migrate time; `propose-takes` embeds new rows opportunistically
--     (fail-soft) and legacy rows stay NULL (the vector stream just skips them,
--     the keyword stream still recalls them). Same width + `<=>` operator the
--     chunk/entity_facts embeddings already use (migration 001/038), so no new
--     extension. No ANN index: the take table is small and the vector scan runs
--     over a LIMIT-bounded candidate set.
--
--  2. Widen the `status` CHECK to admit 'graded'. Today a queued take is graded
--     but its status never advances, so `list_takes(status='queued')` keeps
--     surfacing already-graded takes forever. 'graded' means "has at least one
--     grade row"; the grade phase advances queued→graded after writing a grade,
--     while still re-grading under a NEW prompt_version (the selection admits
--     both 'queued' and 'graded' rows that lack a grade for the current version).
--     'accepted'/'rejected' stay reserved for operator review. Dropping and
--     re-adding the named inline CHECK is deterministic + idempotent.

ALTER TABLE synth_takes
  ADD COLUMN IF NOT EXISTS embedding vector(1024);

ALTER TABLE synth_takes
  DROP CONSTRAINT IF EXISTS synth_takes_status_check;

ALTER TABLE synth_takes
  ADD CONSTRAINT synth_takes_status_check
  CHECK (status IN ('queued', 'accepted', 'rejected', 'graded'));
