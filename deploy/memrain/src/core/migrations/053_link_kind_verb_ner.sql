-- 053_link_kind_verb_ner.sql — widen the links.link_kind CHECK to allow the
-- prose verb-inference edge origin.
--
-- Verb-context inference (src/core/link-verb-infer.ts, opt-in
-- MEMEX_LINK_VERB_INFER) writes typed edges (works_at / invested_in / founded /
-- advises) derived from the prose around a wikilink. They carry a DISTINCT
-- `link_kind='verb_ner'` so the verb-inference sync can DELETE-replace ONLY its
-- own set without touching the `plain` (wikilink + gazetteer) or `typed_ner`
-- (frontmatter typed-links + facts-fence) edges. A verb-inferred edge that
-- collides with a frontmatter `typed_ner` edge on the same (source, target,
-- type) yields via ON CONFLICT DO NOTHING — explicit/frontmatter wins.
--
-- Re-run-safe: drop the old CHECK (migration 029's name) and recreate it with
-- the widened set, guarded on pg_constraint. PGLite-safe (plain ALTER, no
-- extensions).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'links_link_kind_chk') THEN
    ALTER TABLE links DROP CONSTRAINT links_link_kind_chk;
  END IF;
  ALTER TABLE links
    ADD CONSTRAINT links_link_kind_chk
    CHECK (link_kind IS NULL OR link_kind IN ('plain', 'typed_ner', 'verb_ner'));
END $$;
