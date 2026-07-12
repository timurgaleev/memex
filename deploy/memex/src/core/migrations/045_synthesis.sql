-- 045_synthesis.sql — LLM-synthesis subsystem (Wave 5) own-namespace tables.
--
-- This is the ONE area of memex that USES an LLM (Bedrock Nova) to DERIVE
-- higher-level knowledge from the corpus. By explicit operator guard, every
-- byte the synthesis cycle produces lands HERE — never in `documents`,
-- `chunks`, or the authored `pages` graph. Source notes are sacrosanct; this
-- subsystem only reads them.
--
-- Tables (all in the synth_* namespace):
--   synth_atoms          — per-source atomic facts/claims distilled from a note.
--   synth_concepts       — global: clustered/deduped atoms → concept narratives.
--   synth_concept_atoms  — concept↔atom provenance link (which atoms back it).
--   synth_takes          — opinionated "takes" (claim + stance) in a review queue.
--   synth_take_grades    — evidence-grounded confidence verdicts per take.
--   synth_calibration_profile — narrative bias/calibration profile (one row/run).
--
-- Provenance contract (operator non-negotiable): EVERY synthesized row carries
--   - source provenance (the atom/page/take ids it was derived from), and
--   - generated_at (when), and
--   - model_id    (which Nova model produced it).
--
-- Idempotency: each derived row keys on a deterministic content hash of its
-- source so re-running a cycle on unchanged input is a no-op (ON CONFLICT DO
-- NOTHING). Bumping a prompt version invalidates a key cleanly.
--
-- Single-source brain: memex is a flat vault, so there is no `source_id`
-- scoping here (no federated brains). `source_ref` holds
-- the document id / page slug the atom came from.

-- ---------------------------------------------------------------------------
-- Atoms — per-source distilled claims.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS synth_atoms (
  id            BIGSERIAL PRIMARY KEY,
  -- Deterministic idempotency key: hash(source_ref + source_hash + body).
  -- A re-extraction of the same source content produces the same key.
  atom_key      TEXT NOT NULL UNIQUE,
  -- Provenance: where this atom was distilled from (document id or page slug).
  source_ref    TEXT NOT NULL,
  source_kind   TEXT NOT NULL DEFAULT 'document',   -- 'document' | 'page'
  -- 16-char prefix of the source content hash — drives source-change re-extract.
  source_hash   TEXT NOT NULL,
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,
  atom_type     TEXT NOT NULL DEFAULT 'insight',
  -- Free-form concept tags the extractor stamped (drives synth_concepts grouping).
  concepts      JSONB NOT NULL DEFAULT '[]'::jsonb,
  generated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  model_id      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS synth_atoms_source_idx
  ON synth_atoms (source_ref);

CREATE INDEX IF NOT EXISTS synth_atoms_concepts_gin_idx
  ON synth_atoms USING GIN (concepts);

-- ---------------------------------------------------------------------------
-- Concepts — global synthesis over atom clusters.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS synth_concepts (
  id            BIGSERIAL PRIMARY KEY,
  concept_slug  TEXT NOT NULL UNIQUE,
  title         TEXT NOT NULL,
  narrative     TEXT NOT NULL,
  tier          TEXT NOT NULL DEFAULT 'T3',          -- T1 | T2 | T3
  atom_count    INTEGER NOT NULL DEFAULT 0,
  generated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  model_id      TEXT NOT NULL
);

-- Concept↔atom provenance: which atoms a concept was synthesized from.
CREATE TABLE IF NOT EXISTS synth_concept_atoms (
  concept_slug  TEXT NOT NULL,
  atom_id       BIGINT NOT NULL,
  PRIMARY KEY (concept_slug, atom_id),
  FOREIGN KEY (concept_slug) REFERENCES synth_concepts(concept_slug) ON DELETE CASCADE,
  FOREIGN KEY (atom_id)      REFERENCES synth_atoms(id)             ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS synth_concept_atoms_atom_idx
  ON synth_concept_atoms (atom_id);

-- ---------------------------------------------------------------------------
-- Takes — opinionated claims in a review queue (never auto-applied to notes).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS synth_takes (
  id            BIGSERIAL PRIMARY KEY,
  -- Idempotency: hash(source_ref + source_hash + prompt_version + claim_text).
  take_key      TEXT NOT NULL UNIQUE,
  -- Provenance: the document/page the take was derived from.
  source_ref    TEXT NOT NULL,
  source_hash   TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  claim_text    TEXT NOT NULL,
  -- 'prediction' | 'judgment' | 'bet'
  kind          TEXT NOT NULL DEFAULT 'judgment'
                  CHECK (kind IN ('prediction', 'judgment', 'bet')),
  -- Author's conviction inferred from hedging language, 0..1.
  weight        DOUBLE PRECISION NOT NULL DEFAULT 0.5,
  domain        TEXT,
  -- 'queued' (default) | 'accepted' | 'rejected' — operator review state.
  status        TEXT NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued', 'accepted', 'rejected')),
  generated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  model_id      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS synth_takes_status_idx
  ON synth_takes (status);

CREATE INDEX IF NOT EXISTS synth_takes_source_idx
  ON synth_takes (source_ref);

-- ---------------------------------------------------------------------------
-- Take grades — evidence-grounded verdict per take (review-queue posture; the
-- grade is advisory and NEVER mutates the take's source note).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS synth_take_grades (
  id            BIGSERIAL PRIMARY KEY,
  take_id       BIGINT NOT NULL,
  prompt_version TEXT NOT NULL,
  -- Hash of the evidence text + model — re-grading with new evidence is a new row.
  evidence_signature TEXT NOT NULL,
  verdict       TEXT NOT NULL
                  CHECK (verdict IN ('correct', 'incorrect', 'partial', 'unresolvable')),
  confidence    DOUBLE PRECISION NOT NULL DEFAULT 0,
  reasoning     TEXT NOT NULL DEFAULT '',
  generated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  model_id      TEXT NOT NULL,
  UNIQUE (take_id, prompt_version, evidence_signature),
  FOREIGN KEY (take_id) REFERENCES synth_takes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS synth_take_grades_take_idx
  ON synth_take_grades (take_id);

-- ---------------------------------------------------------------------------
-- Calibration profile — one narrative row per run (append-only history).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS synth_calibration_profile (
  id              BIGSERIAL PRIMARY KEY,
  generated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  total_graded    INTEGER NOT NULL DEFAULT 0,
  correct         INTEGER NOT NULL DEFAULT 0,
  incorrect       INTEGER NOT NULL DEFAULT 0,
  partial         INTEGER NOT NULL DEFAULT 0,
  unresolvable    INTEGER NOT NULL DEFAULT 0,
  accuracy        DOUBLE PRECISION,
  -- Provenance: the take-grade ids the scorecard was computed from.
  graded_take_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  pattern_statements JSONB NOT NULL DEFAULT '[]'::jsonb,
  bias_tags       JSONB NOT NULL DEFAULT '[]'::jsonb,
  model_id        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS synth_calibration_profile_time_idx
  ON synth_calibration_profile (generated_at DESC);
