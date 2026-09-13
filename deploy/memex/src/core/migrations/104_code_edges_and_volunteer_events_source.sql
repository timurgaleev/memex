-- 104_code_edges_and_volunteer_events_source.sql — give existing code edges and
-- volunteer events the source of what they point at.
--
-- Code edges were written with source_id NULL, so a scoped caller's code_blast
-- and code_flow — which filter edges by source — walked an empty graph, while
-- structural expansion let every NULL edge through. Edges now take the source of
-- the chunk's document at write time; this fills the rows written before that.
--
-- Volunteer events were written with source_id NULL as well, so their usage
-- stats could only be served whole-brain. Events now carry the volunteered
-- page's source; this fills the existing ones recorded while that page existed.
--
-- Rows whose document or page has no source stay NULL: they belong to no grant,
-- and only the unscoped operator reads them. Idempotent: only NULLs are filled.

UPDATE code_edges_symbol e
   SET source_id = d.source_id
  FROM chunks c
  JOIN documents d ON d.id = c.document_id
 WHERE e.from_chunk_id = c.id
   AND e.source_id IS NULL
   AND d.source_id IS NOT NULL;

-- An event can outlive a purged page whose slug another source later reuses, so
-- only an event recorded after the current page row was created is attributed
-- to it; older ones stay NULL.
UPDATE context_volunteer_events v
   SET source_id = p.source_id
  FROM pages p
 WHERE v.slug = p.slug
   AND v.source_id IS NULL
   AND v.volunteered_at >= p.created_at;

-- Last, so the lock it takes on the edge table is held for as short a time as
-- the migration transaction allows.
CREATE INDEX IF NOT EXISTS code_edges_symbol_source_idx
  ON code_edges_symbol (source_id);
