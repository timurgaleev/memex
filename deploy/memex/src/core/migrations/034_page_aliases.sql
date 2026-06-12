-- 034_page_aliases.sql — declared free-text aliases for a page.
--
-- A page can declare alternate names in its `compiled_truth.aliases` array
-- (the frontmatter analog): a `people/bob` page with
-- `aliases: ["Robert", "Bobby"]` should let a `[[Robert]]` wikilink resolve
-- to `people/bob`. This table is the normalized index of those declarations.
--
-- `alias_norm` is the normalized alias string (lowercase, NFKC,
-- whitespace-collapsed — see core/page-aliases.ts normalizeAlias), NOT a
-- slug: aliases are free-text names, not kebab-case slugs. The wikilink
-- resolver consults this index as a high-confidence stage (a DECLARED alias
-- is authoritative, ranked just below an exact slug match and above the
-- fuzzy tail/prefix/trigram cascade).
--
-- The PRIMARY KEY (alias_norm, slug) lets the SAME alias point at more than
-- one page (two pages legitimately claim "Standup"): a collision. The
-- resolver detects the collision (>1 slug for an alias) and falls through
-- rather than arbitrating — same safe-by-default posture as the slug
-- canonicalizer. The composite PK's leading column also serves the
-- by-alias lookup, so no separate index is needed.
--
-- ON DELETE CASCADE keeps the index in lockstep with a hard page delete;
-- soft-deleted pages (deleted_at) stay in the table but are filtered out by
-- the resolver's join on `pages.deleted_at IS NULL`, so a restore brings the
-- alias back automatically.
--
-- No backfill: declared aliases are a NEW convention introduced here, so no
-- pre-existing page carries one to index. A page lights up its aliases on its
-- next putPage.

CREATE TABLE IF NOT EXISTS page_aliases (
  alias_norm  TEXT NOT NULL,
  slug        TEXT NOT NULL REFERENCES pages(slug) ON DELETE CASCADE,
  PRIMARY KEY (alias_norm, slug)
);

-- The composite PK's leading column serves by-alias lookups; the per-page
-- replace (`DELETE ... WHERE slug = $1` in setPageAliases) needs its own index
-- or it would table-scan on every alias-bearing page write.
CREATE INDEX IF NOT EXISTS page_aliases_slug_idx ON page_aliases(slug);
