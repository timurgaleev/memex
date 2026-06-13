-- 036_pages_salience.sql — deterministic page-importance score.
--
-- `salience` is a [0..1] score recomputed by the `recompute-salience` cycle
-- phase from a page's high-emotion tags + graph link-degree (LLM-free,
-- deterministic). It feeds the "what matters" salience surface (`memex
-- salience` CLI and the read-only recent-salience query) — NOT the document
-- hybrid-search ranking, which stays driven by the existing frontmatter
-- `weight`/`pinned` multiplier. The two signals are deliberately separate:
-- salience ranks PAGES (graph entities) by mattering; the frontmatter
-- multiplier nudges DOCUMENT chunks in full-text/vector search.
--
-- Default 0.0 so every existing page is neutral until the next cycle backfills
-- it. No index: the `memex salience` surface orders by `salience DESC,
-- updated_at DESC` over the live page set (~10^3 rows) — a full scan + sort is
-- cheap at this scale, and the `--days` window already prunes via
-- pages_updated_desc_idx. Add a dedicated `(salience DESC)` index only if the
-- page count grows enough for the all-time sort to matter.

ALTER TABLE pages
  ADD COLUMN IF NOT EXISTS salience REAL NOT NULL DEFAULT 0.0;
