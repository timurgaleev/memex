-- 064_synth_contradictions.sql — latent-contradiction probe findings (Item 3).
--
-- A paid, default-OFF Sonnet cycle phase (`probe-contradictions`) judges pairs
-- of facts/takes that plausibly conflict and records the SUSPECTED
-- contradictions here. This is the LLM-derived complement to the deterministic
-- `contradicts` graph edges (migration 016) that `find_contradictions` reads:
-- the graph surfaces conflicts an author asserted; this surfaces conflicts the
-- probe suspects. Advisory only — a finding NEVER mutates a fact/take/edge.
--
-- Provenance contract: every row carries model_id + prompt_version + generated_at
-- and the two sides it was derived from. Idempotency: `pair_key` = hash of the
-- ordered (a_ref, b_ref) + prompt_version, so re-probing the same pair under the
-- same prompt is a no-op (ON CONFLICT DO NOTHING). Additive + idempotent DDL.
--
-- Tenancy: `source_id` scopes a finding to a tenant (the source both sides came
-- from). NULL = unscoped/legacy. `find_contradictions` filters on it fail-closed
-- when a read scope is supplied, matching migration 047's posture.

CREATE TABLE IF NOT EXISTS synth_contradictions (
  id                  BIGSERIAL PRIMARY KEY,
  -- Deterministic idempotency key: hash(a_ref + b_ref + prompt_version).
  pair_key            TEXT NOT NULL UNIQUE,
  -- The two conflicting sides. *_ref points at the underlying row (a fact id, a
  -- take_key, or a page slug); *_kind names which. *_text is the claim snapshot.
  a_ref               TEXT NOT NULL,
  a_kind              TEXT NOT NULL DEFAULT 'fact',   -- 'fact' | 'take' | 'page'
  a_text              TEXT NOT NULL,
  b_ref               TEXT NOT NULL,
  b_kind              TEXT NOT NULL DEFAULT 'fact',
  b_text              TEXT NOT NULL,
  -- The judged conflict. severity: 'low' | 'medium' | 'high'; axis: the dimension
  -- the two disagree on (free text, e.g. 'timing', 'value', 'stance').
  severity            TEXT NOT NULL DEFAULT 'low'
                        CHECK (severity IN ('low', 'medium', 'high')),
  axis                TEXT NOT NULL DEFAULT '',
  confidence          DOUBLE PRECISION NOT NULL DEFAULT 0,
  -- A suggested MCP command the operator could run to resolve it (advisory).
  resolution_command  TEXT NOT NULL DEFAULT '',
  source_id           TEXT,
  prompt_version      TEXT NOT NULL,
  generated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  model_id            TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS synth_contradictions_severity_idx
  ON synth_contradictions (severity, confidence DESC);

CREATE INDEX IF NOT EXISTS synth_contradictions_source_idx
  ON synth_contradictions (source_id);

CREATE INDEX IF NOT EXISTS synth_contradictions_ref_idx
  ON synth_contradictions (a_ref, b_ref);
