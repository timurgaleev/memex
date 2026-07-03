-- 066_embeddings_signature.sql — embedding provenance signature.
--
-- Stamps each embeddings row with `provider:model:dims` (see
-- core/embedding.ts `embeddingSignature`) at write time. The stale/backfill
-- loop compares a row's stored signature to the current one and re-embeds ONLY
-- rows whose signature actually differs, so a model or dimension swap
-- re-embeds automatically instead of silently serving mixed-provenance vectors.
--
-- Additive + safe: the column is nullable and defaults to NULL. Existing rows
-- (embedded before this migration) carry NULL and are NEVER auto-invalidated —
-- a NULL signature is treated as "unknown, leave alone", so turning this on
-- does NOT force a full re-embed of the existing corpus. Rows written after
-- this migration carry a real signature, so a future swap auto-invalidates
-- exactly them.

ALTER TABLE embeddings
  ADD COLUMN IF NOT EXISTS embedding_signature TEXT;

-- Partial index over the stamped rows only — the invalidation sweep filters on
-- `embedding_signature IS NOT NULL AND embedding_signature <> $current`, so the
-- NULL legacy rows never need to be scanned.
CREATE INDEX IF NOT EXISTS embeddings_signature_idx
  ON embeddings(embedding_signature)
  WHERE embedding_signature IS NOT NULL;
