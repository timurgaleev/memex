-- 067_slug_aliases.sql — source-scoped slug→canonical-slug redirect registry.
--
-- DISTINCT from page_aliases (migration 034). The two answer different
-- questions and never overlap:
--   - page_aliases:  a normalized FREE-TEXT name ("Robert", "Bobby") → slug,
--                    consulted by the wikilink canonicalizer as a declared-alias
--                    stage. The alias key is a phrase, not a slug.
--   - slug_aliases:  an OLD SLUG → the CANONICAL SLUG it now redirects to. This
--                    is a durable forwarding record left behind when a page is
--                    RENAMED or MERGED, so a stale `[[old-slug]]` wikilink and a
--                    direct `page_get old-slug` still resolve to the live page.
--
-- Source-scoped (migration 047 tenant axis): the SAME `alias_slug` may forward
-- to different canonical slugs under different tenants, so the redirect resolves
-- ONLY against the caller's own source(s). The unique key is
-- (source_id, alias_slug) — one forwarding target per (tenant, old-slug).
--
-- `alias_slug <> canonical_slug` guards a self-redirect (which would loop the
-- resolver's short-circuit). Multi-hop chains (a→b, b→c) are NOT followed
-- transitively — the resolver does a single hop; the rename primitive is
-- responsible for pointing an old redirect at the final canonical slug when a
-- page is renamed twice (see core/pages.ts renamePage / core/slug-aliases.ts).
--
-- No backfill: redirects are a NEW convention introduced here. No pre-existing
-- page carries one; rows appear only as pages are renamed/merged from now on.

CREATE TABLE IF NOT EXISTS slug_aliases (
  id             BIGSERIAL PRIMARY KEY,
  source_id      TEXT NOT NULL DEFAULT 'default',
  alias_slug     TEXT NOT NULL,
  canonical_slug TEXT NOT NULL,
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT slug_aliases_no_self CHECK (alias_slug <> canonical_slug),
  CONSTRAINT slug_aliases_uniq UNIQUE (source_id, alias_slug)
);

-- Reverse lookup: "what old slugs forward to this canonical page" — used when a
-- page is renamed again so its existing redirects can be re-pointed. Source-
-- scoped to match the resolver's join.
CREATE INDEX IF NOT EXISTS slug_aliases_canonical_idx
  ON slug_aliases (source_id, canonical_slug);
