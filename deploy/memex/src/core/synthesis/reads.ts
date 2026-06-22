/**
 * Read-side accessors for synthesized content (migration 045). Back the
 * list_concepts / list_takes / get_calibration_profile MCP tools. Deterministic
 * SELECTs over the synth_* tables; fail-open to empty on a pre-045 brain.
 *
 * These read content the LLM synthesis phases derived FROM the user's notes;
 * they never touch documents/pages. Internal-only at the MCP layer.
 */
import type { Engine } from "../engine/interface.ts";

function clampLimit(limit: number | undefined, max: number, dflt: number): number {
  return typeof limit === "number" && limit >= 1 && limit <= max
    ? Math.floor(limit)
    : dflt;
}

export interface ConceptRow {
  concept_slug: string;
  title: string;
  tier: string;
  atom_count: number;
  narrative: string;
  generated_at: string;
}

export async function listConcepts(
  engine: Engine,
  limit?: number,
): Promise<ConceptRow[]> {
  const n = clampLimit(limit, 200, 50);
  try {
    const r = await engine.query<ConceptRow>(
      `SELECT concept_slug, title, tier, atom_count, narrative,
              generated_at::text AS generated_at
         FROM synth_concepts
        ORDER BY atom_count DESC, concept_slug ASC
        LIMIT $1`,
      [n],
    );
    return r.rows;
  } catch {
    return []; // pre-045 brain — synth tables don't exist yet
  }
}

export interface TakeRow {
  take_key: string;
  claim_text: string;
  kind: string;
  weight: number;
  domain: string | null;
  status: string;
  generated_at: string;
}

export async function listTakes(
  engine: Engine,
  opts: { status?: string; limit?: number } = {},
): Promise<TakeRow[]> {
  const n = clampLimit(opts.limit, 200, 50);
  const status = typeof opts.status === "string" ? opts.status : null;
  try {
    const r = await engine.query<TakeRow>(
      `SELECT take_key, claim_text, kind, weight, domain, status,
              generated_at::text AS generated_at
         FROM synth_takes
        WHERE ($1::text IS NULL OR status = $1)
        ORDER BY generated_at DESC, take_key ASC
        LIMIT $2`,
      [status, n],
    );
    return r.rows;
  } catch {
    return [];
  }
}

export interface CalibrationProfileRow {
  generated_at: string;
  total_graded: number;
  correct: number;
  incorrect: number;
  partial: number;
  unresolvable: number;
  accuracy: number | null;
  pattern_statements: unknown;
  bias_tags: unknown;
  model_id: string;
}

export async function getCalibrationProfile(
  engine: Engine,
): Promise<CalibrationProfileRow | null> {
  try {
    const r = await engine.query<CalibrationProfileRow>(
      `SELECT generated_at::text AS generated_at, total_graded, correct,
              incorrect, partial, unresolvable, accuracy,
              pattern_statements, bias_tags, model_id
         FROM synth_calibration_profile
        ORDER BY generated_at DESC
        LIMIT 1`,
    );
    return r.rows[0] ?? null;
  } catch {
    return null;
  }
}
