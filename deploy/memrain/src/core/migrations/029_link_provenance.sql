-- 029_link_provenance.sql — make the link-provenance columns USABLE.
--
-- Migration 024 (P0) already laid five provenance columns on `links` as bare
-- nullable TEXT stubs ("P0 only lays the columns"):
--   context, link_kind, origin_page_id, origin_field, resolution_type
-- Nothing populated or constrained them. This migration turns those stubs
-- into a usable contract so a future LLM-free enrichment pass (gazetteer
-- auto-link, typed-NER) and a reconcile pass can rely on them:
--   * context        — NOT NULL DEFAULT '' (a missing window is '', never NULL)
--   * link_kind      — CHECK plain | typed_ner (NULL = pre-provenance edge)
--   * resolution_type— CHECK qualified | unqualified
--   * origin_page_id — RENAMED to origin_slug. 024 mis-named it after an
--                      integer page id, but this brain is
--                      slug-keyed (pages PK is the slug, like
--                      source_slug/target_slug). The column is an unused stub
--                      (all NULL on live), so the rename is metadata-only.
--
-- origin_slug is a SOFT reference (no FK) — consistent with target_slug, whose
-- target "may or may not exist when the edge is recorded". Adding a FK on a
-- live column risks a boot-time validation failure for negligible gain.
--
-- Re-run-safe: every step is guarded (column-existence / pg_constraint /
-- IF NOT EXISTS) so re-applying is a no-op, not an error. No public/redaction
-- surface — the graph read tools project explicit columns that exclude these,
-- and the public allowlist (PUBLIC_SAFE_GRAPH_FIELDS) excludes them too.

-- 1. context: default '' + backfill the existing NULLs + enforce NOT NULL.
ALTER TABLE links ALTER COLUMN context SET DEFAULT '';
UPDATE links SET context = '' WHERE context IS NULL;
ALTER TABLE links ALTER COLUMN context SET NOT NULL;

-- 2. Rename the mis-named origin_page_id → origin_slug (guarded, idempotent).
DO $$
BEGIN
  IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'links' AND column_name = 'origin_page_id'
     ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'links' AND column_name = 'origin_slug'
     ) THEN
    ALTER TABLE links RENAME COLUMN origin_page_id TO origin_slug;
  END IF;
END $$;

-- 3. Enum CHECK constraints (NULL allowed = pre-provenance edges). `ADD
--    CONSTRAINT` has no IF NOT EXISTS, so guard on pg_constraint (the
--    migration-028 lesson) to stay re-run-safe.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'links_link_kind_chk') THEN
    ALTER TABLE links
      ADD CONSTRAINT links_link_kind_chk
      CHECK (link_kind IS NULL OR link_kind IN ('plain', 'typed_ner'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'links_resolution_type_chk') THEN
    ALTER TABLE links
      ADD CONSTRAINT links_resolution_type_chk
      CHECK (resolution_type IS NULL OR resolution_type IN ('qualified', 'unqualified'));
  END IF;
END $$;

-- 4. Index for origin-scoped reconcile sweeps (only inferred edges carry it).
CREATE INDEX IF NOT EXISTS links_origin_slug_idx
  ON links(origin_slug)
  WHERE origin_slug IS NOT NULL;
