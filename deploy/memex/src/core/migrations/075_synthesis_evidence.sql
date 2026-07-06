-- 075: synthesis_evidence — durable citation rows for persisted think output.
--
-- `think --save` (and any caller of persistThinkSynthesis) writes the synthesis
-- as a real `synthesis/<slug>` page; this table records WHICH evidence the
-- answer rested on, one row per validated citation. Unlike the reference's
-- take-FK shape (its citations key on pages(id) + takes(page_id,row_num)),
-- memex citations are a page source path OR a synth_takes take_key — both TEXT
-- refs — so the table stores the ref + kind directly. No FK: a cited page path
-- may belong to the documents mirror rather than the pages graph, and a pruned
-- take must not cascade away the synthesis's provenance record.
--
-- Additive + idempotent: IF NOT EXISTS; UNIQUE key makes re-persisting the same
-- synthesis a no-op (ON CONFLICT DO NOTHING at the application layer).

CREATE TABLE IF NOT EXISTS synthesis_evidence (
  id             BIGSERIAL PRIMARY KEY,
  -- The saved synthesis page slug (synthesis/<question-slug>-<date>).
  synthesis_slug TEXT NOT NULL,
  -- The cited evidence: a page source path (kind='page') or take_key (kind='take').
  ref            TEXT NOT NULL,
  kind           TEXT NOT NULL DEFAULT 'page' CHECK (kind IN ('page', 'take')),
  -- Position of the citation in the model's citation list (0-based).
  citation_index INTEGER NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (synthesis_slug, kind, ref)
);

CREATE INDEX IF NOT EXISTS synthesis_evidence_ref_idx
  ON synthesis_evidence (ref);
