-- 020_hot_memory.sql -- short-term fact buffer with supersession.
--
-- The `entity_facts` table (migration 018) is the permanent ledger:
-- every row is durable, deduped against the source chunk, and ranked
-- by confidence. `hot_memory` is the inbox in front of it -- recent
-- observations the agent has just made (this session, last hour,
-- last day) that have NOT YET been promoted into `entity_facts`.
--
-- Why two layers? Two reasons:
--
--   1. Conflict resolution. A recipe ingests "Alice works at Acme"
--      on Monday and "Alice works at Globex" on Friday. The two
--      facts contradict. `hot_memory.superseded_by` lets the
--      later observation point at the earlier one -- both rows
--      remain inspectable, the unsuperseded set is queryable, and
--      the consolidate dream phase promotes only the surviving
--      claim into the permanent `entity_facts` ledger.
--
--   2. Confidence aging. A claim made under uncertainty (low
--      effective_confidence) stays in `hot_memory` until enough
--      corroborating observations bring it over the promotion
--      threshold OR the dream cycle ages it out.
--
-- A.5 ships the SCHEMA only -- the consolidate behaviour lands in
-- a future dream-cycle phase. The MCP surface for hot_memory is
-- deferred to the same later phase; today only internal recipes
-- write here (via core/hot_memory.ts).

CREATE TABLE IF NOT EXISTS hot_memory (
  id                     BIGSERIAL PRIMARY KEY,
  entity_slug            TEXT NOT NULL,
  fact                   TEXT NOT NULL,
  effective_confidence   REAL NOT NULL DEFAULT 1.0,
  session_id             TEXT,
  source_slug            TEXT,
  source_chunk_id        TEXT,
  written_by             TEXT,
  superseded_by          BIGINT REFERENCES hot_memory(id) ON DELETE SET NULL,
  written_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT hot_memory_confidence_range_chk
    CHECK (effective_confidence >= 0.0 AND effective_confidence <= 1.0)
);

CREATE INDEX IF NOT EXISTS hot_memory_entity_time_idx
  ON hot_memory(entity_slug, written_at DESC);

CREATE INDEX IF NOT EXISTS hot_memory_session_idx
  ON hot_memory(session_id)
  WHERE session_id IS NOT NULL;

-- Unsuperseded subset -- this is the hot working set the
-- consolidate phase reads.
CREATE INDEX IF NOT EXISTS hot_memory_unsuperseded_idx
  ON hot_memory(entity_slug, effective_confidence DESC)
  WHERE superseded_by IS NULL;
