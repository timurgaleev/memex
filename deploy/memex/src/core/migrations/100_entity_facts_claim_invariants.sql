-- 100_entity_facts_claim_invariants.sql — every claim ages, every claim names
-- a writer.
--
-- Two ledger invariants were enforced nowhere, so the live table drifted out of
-- them row by row:
--
--   1. `kind` drives confidence decay (core/facts-decay.ts HALFLIFE_DAYS), and a
--      row with the column blank is invisible to it — it never ages. Consolidated
--      takes and fence rows both landed that way, so a take stayed at full
--      strength forever while the member facts under it decayed. The write paths
--      now floor an unstated kind to 'belief' (core/facts-decay.ts
--      DEFAULT_FACT_KIND); this backfills the rows written before they did.
--
--   2. `written_by` is the audit field. The add_fact MCP tool credits its caller,
--      but it is one caller of many, so rows kept arriving NULL from the CLI, the
--      extractor and any writer that named a source page instead. core/facts.ts
--      now credits UNATTRIBUTED_WRITER when a caller names nobody.
--
-- Existing NULLs are BACKFILLED rather than tolerated. A read surface that has
-- to branch on NULL cannot rely on the invariant at all, and both sentinels are
-- honest about what is (not) known: 'belief' is the floor for a claim nobody
-- classified, 'unattributed' says the provenance was never recorded — which is
-- a readable answer where NULL is a hole every reader guesses at differently.
-- Nothing is deleted: the duplicate rows the missing insert-time dedup already
-- minted stay on file (collapsing them is an operator decision, not a
-- migration's).
--
-- Idempotent: both statements only ever touch NULL cells, so a re-run over a
-- backfilled brain is a no-op.

-- 'belief' is DEFAULT_FACT_KIND. It satisfies the mig037 kind CHECK, and it is
-- the slowest-decaying kind bar 'fact', so a legacy row is nudged into aging
-- rather than dropped down the ranking. Dimensional rows (mig097) already carry
-- kind='fact' and are untouched.
UPDATE entity_facts
   SET kind = 'belief'
 WHERE kind IS NULL;

-- 'unattributed' is UNATTRIBUTED_WRITER. Scoped to the fact ledger
-- (dimension IS NULL): dimensional ontology rows are projected by
-- core/ontology-facts.ts, which writes no writer at all, so backfilling them
-- would assert an invariant the very next observation breaks.
UPDATE entity_facts
   SET written_by = 'unattributed'
 WHERE written_by IS NULL
   AND dimension IS NULL;

-- No unique index backs the claim identity (source_id, entity_slug, fact,
-- written_by) on purpose. `fact` is unbounded TEXT and a btree tuple over it
-- would hit the 2704-byte index-row limit for a long claim — aborting the very
-- write it exists to protect — and the live table already holds the duplicates
-- a unique index would refuse to build over. The lookup rides
-- entity_facts_entity_time_idx (entity_slug leading); a per-entity ledger is
-- small enough that the residual scan is not a cost.
