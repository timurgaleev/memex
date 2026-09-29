-- 059_links_tags_source_id_unique.sql — make the links + tags uniqueness keys
-- tenant-aware by folding source_id into them.
--
-- WHY: the graph-edge key was UNIQUE(source_slug, target_slug, type) and the
-- tag key was PRIMARY KEY(slug, tag) — both OMIT source_id. Under multi-tenant
-- writes that lets tenant B's `INSERT ... ON CONFLICT (source_slug, target_slug,
-- type) DO UPDATE` land on tenant A's row for the same triple and re-stamp it in
-- place (edge/tag tamper), because the conflict arbitration never sees the
-- owning source. Widening the key to include source_id gives each tenant its own
-- row for the same (triple)/(slug,tag): a per-tenant write can only ever conflict
-- with — and update — its OWN row.
--
-- COLLISION-SAFE ON LIVE DATA: migration 047 backfilled every existing links /
-- tags row to source_id='default' (NOT NULL DEFAULT 'default'), so source_id is
-- CONSTANT across the live corpus. The old key already guaranteed the triple /
-- (slug,tag) was unique, and appending a constant column can never introduce a
-- duplicate — the new UNIQUE constraint is functionally identical on today's
-- single-source data. Dropping + recreating the unique index therefore cannot
-- fail on live rows, and the single-tenant path (all rows 'default') keeps its
-- exact prior conflict behavior.
--
-- Additive + idempotent + catalog-guarded: the DROPs use IF EXISTS on the
-- deterministic auto-names (mig 016 `UNIQUE (...)` → links_source_slug_target_slug_type_key;
-- mig 023 `PRIMARY KEY (slug, tag)` → tags_pkey), and each ADD is guarded on
-- pg_constraint so a re-apply is a no-op, not an error. PGLite-safe (plain ALTER
-- + a DO block, the same idiom as migrations 029 / 053).

-- 1. links — widen UNIQUE(source_slug, target_slug, type) → include source_id.
ALTER TABLE links DROP CONSTRAINT IF EXISTS links_source_slug_target_slug_type_key;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'links_source_target_type_source_id_key'
  ) THEN
    ALTER TABLE links
      ADD CONSTRAINT links_source_target_type_source_id_key
      UNIQUE (source_slug, target_slug, type, source_id);
  END IF;
END $$;

-- 2. tags — widen PRIMARY KEY(slug, tag) → a UNIQUE(slug, tag, source_id). The
--    table has no FK referencing it (mig 023 standalone), so dropping the PK is
--    safe; the new UNIQUE is the conflict target ON CONFLICT (slug, tag,
--    source_id) resolves against.
ALTER TABLE tags DROP CONSTRAINT IF EXISTS tags_pkey;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tags_slug_tag_source_id_key'
  ) THEN
    ALTER TABLE tags
      ADD CONSTRAINT tags_slug_tag_source_id_key
      UNIQUE (slug, tag, source_id);
  END IF;
END $$;
