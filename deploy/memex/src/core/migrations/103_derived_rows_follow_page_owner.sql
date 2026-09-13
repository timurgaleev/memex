-- 103_derived_rows_follow_page_owner.sql — move rows an unscoped writer stamped
-- `default` onto the source that owns their page.
--
-- Until now an unscoped write (the operator, the local CLI) into a page owned by
-- another source wrote its delete/restore version markers under the column
-- DEFAULT 'default', so the owning tenant's scoped history missed the deletion.
-- The write path now stamps the page's source; this brings existing markers in
-- line. Versions cascade with their page, so a marker always belongs to the page
-- row it sits under.
--
-- Tags are deliberately NOT moved: they carry no foreign key to the page, so a
-- tag can outlive a purged page whose slug another source later reuses, and
-- moving it by slug would hand one tenant another's labels.
--
-- Only markers on a page owned by a named (non-default) source move.
-- Idempotent: a second run finds nothing left in `default` to move.

-- Delete and restore markers: an empty body snapshot whose compiled truth is
-- the one-key event record deletePage / restorePage write.
UPDATE page_versions v
   SET source_id = p.source_id
  FROM pages p
 WHERE v.slug = p.slug
   AND v.source_id = 'default'
   AND p.source_id <> 'default'
   AND v.body_snapshot = ''
   AND v.hash_prev = v.hash_new
   AND (v.compiled_truth_snapshot ? 'deleted_at' OR v.compiled_truth_snapshot ? 'restored_at');
