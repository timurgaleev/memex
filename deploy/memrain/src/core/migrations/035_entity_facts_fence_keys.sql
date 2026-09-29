-- 035_entity_facts_fence_keys.sql — fence-reconciliation keys for entity_facts.
--
-- The `## Facts` fence (core/facts-fence.ts, v1.3.32) is a hand-editable
-- markdown table that is the SYSTEM OF RECORD for a page's facts. The
-- reconcile pass (core/facts-reconcile.ts) makes the DB index byte-match the
-- fence on every page write: it WIPES the page's fence-owned fact rows and
-- re-inserts them from the parsed fence.
--
-- To scope that wipe to ONLY the fence-derived rows (never touching a legacy
-- or explicitly-asserted fact), entity_facts needs two new keys:
--   - `source_markdown_slug` — the page whose fence the row came from. The
--     reconcile wipe is `DELETE ... WHERE source_markdown_slug = <page>`, so a
--     row with NULL source_markdown_slug (every pre-fence / explicit `add_fact`
--     row) is INVISIBLE to the wipe and survives untouched. The column scoping
--     IS the empty-fence guard — no separate legacy-row check is needed.
--   - `row_num` — the fence's `#` column, so the DB row maps back to its fence
--     line (stable identity across edits).
--
-- Both columns are NULLABLE and additive (ADD COLUMN IF NOT EXISTS) — no data
-- rewrite, no backfill, no behavior change for existing rows. The index on
-- source_markdown_slug keeps the per-page wipe from scanning the ledger.

ALTER TABLE entity_facts ADD COLUMN IF NOT EXISTS source_markdown_slug TEXT;
ALTER TABLE entity_facts ADD COLUMN IF NOT EXISTS row_num INTEGER;

CREATE INDEX IF NOT EXISTS entity_facts_source_md_idx
  ON entity_facts(source_markdown_slug);
