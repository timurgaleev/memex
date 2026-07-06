-- 086_links_link_source.sql — per-edge writer provenance + widened unique key
-- (reference parity: links.link_source).
--
-- WHY: the mig059 unique key (source_slug, target_slug, type, source_id) makes
-- edges from DIFFERENT writers collide on the same triple — a manual `link`
-- call, a frontmatter typed edge, and a body-mention edge all fight over one
-- row (today the collision is resolved by ON CONFLICT DO NOTHING /
-- last-writer-wins on confidence). The reference keeps them as separate rows
-- keyed by `link_source`, so each writer owns — and can sweep — its own edge
-- set, and ranking can exclude auto-mention edges by provenance rather than by
-- the `type='mentions'` proxy (which misses verb-derived typed mentions).
--
-- Values (mirroring the reference's vocabulary):
--   manual      — explicit addLink / MCP `link` call
--   markdown    — body-derived: wikilink scanner, markdown links, doc→code refs
--   frontmatter — typed edges projected from compiled_truth fields
--   mentions    — auto-linked body-text mentions (gazetteer) AND verb-inferred
--                 typed edges (the reference files verb edges under 'mentions'
--                 with a distinguishing link_kind; memex keeps link_kind
--                 'verb_ner' for that)
--
-- Backfill maps each existing row to its writer via link_kind/type — the
-- writers stamp those deterministically, so provenance is fully recoverable:
--   verb_ner                  → mentions   (verb-inference sweep)
--   type=mentions + plain     → mentions   (gazetteer sweep)
--   typed_ner                 → frontmatter (typed-links fence writer)
--   plain (rest)              → markdown   (wikilink / markdown / code-ref sync)
--   everything else           → manual     (explicit calls, pre-provenance rows)
--
-- MEMEX ADAPTATION: the reference's key is UNIQUE NULLS NOT DISTINCT with a
-- nullable link_source; memex makes the column NOT NULL DEFAULT 'manual'
-- instead, which yields identical collision semantics on a plain UNIQUE
-- without requiring PG15's NULLS NOT DISTINCT on both engines.
--
-- Collision safety: the old key was unique; appending a deterministic
-- backfilled column cannot introduce duplicates, so the widened constraint
-- always builds on live data.

ALTER TABLE links ADD COLUMN IF NOT EXISTS link_source TEXT;

UPDATE links SET link_source = 'mentions'
 WHERE link_source IS NULL
   AND (link_kind = 'verb_ner' OR (type = 'mentions' AND link_kind = 'plain'));

UPDATE links SET link_source = 'frontmatter'
 WHERE link_source IS NULL AND link_kind = 'typed_ner';

UPDATE links SET link_source = 'markdown'
 WHERE link_source IS NULL AND link_kind = 'plain';

UPDATE links SET link_source = 'manual' WHERE link_source IS NULL;

ALTER TABLE links ALTER COLUMN link_source SET DEFAULT 'manual';
ALTER TABLE links ALTER COLUMN link_source SET NOT NULL;

-- Same kebab-case + length guard the reference enforces on the column.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'links_link_source_chk'
  ) THEN
    ALTER TABLE links
      ADD CONSTRAINT links_link_source_chk
      CHECK (link_source ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'
             AND char_length(link_source) <= 64);
  END IF;
END $$;

-- Widen the unique key: (source_slug, target_slug, type, source_id) →
-- + link_source. The write paths' ON CONFLICT targets move in lockstep
-- (core/links.ts, gazetteer.ts, typed-links.ts — same deploy).
ALTER TABLE links DROP CONSTRAINT IF EXISTS links_source_target_type_source_id_key;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'links_source_target_type_source_link_source_key'
  ) THEN
    ALTER TABLE links
      ADD CONSTRAINT links_source_target_type_source_link_source_key
      UNIQUE (source_slug, target_slug, type, source_id, link_source);
  END IF;
END $$;

-- Provenance-scoped sweeps + the backlink-ranking exclusion filter.
CREATE INDEX IF NOT EXISTS idx_links_link_source ON links (link_source);
