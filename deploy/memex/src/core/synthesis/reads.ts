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

/**
 * Normalise an optional caller-supplied tenant filter. `undefined`/empty stays
 * unscoped; a non-empty list is deduped to a clean `string[]` for `$n::text[]`.
 */
function normalizeSourceIds(sourceIds: string[] | undefined): string[] | undefined {
  if (!Array.isArray(sourceIds) || sourceIds.length === 0) return undefined;
  const cleaned = sourceIds.filter((s) => typeof s === "string" && s.length > 0);
  return cleaned.length > 0 ? Array.from(new Set(cleaned)) : undefined;
}

export interface ConceptRow {
  concept_slug: string;
  title: string;
  tier: string;
  atom_count: number;
  narrative: string;
  generated_at: string;
}

/**
 * @param sourceIds Accepted for API symmetry with the other scoped reads, but
 *   NOT applied: `synth_concepts` is a GLOBAL aggregate — concepts cluster atoms
 *   across every source (migration 045 has no `source_id` on the table), so
 *   there is no row-level tenant axis to filter on. Passing it is a no-op.
 */
export async function listConcepts(
  engine: Engine,
  limit?: number,
  _sourceIds?: string[],
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
  opts: { status?: string; limit?: number; sourceIds?: string[] } = {},
): Promise<TakeRow[]> {
  const n = clampLimit(opts.limit, 200, 50);
  const status = typeof opts.status === "string" ? opts.status : null;
  // Takes carry only `source_ref` (the document id they were distilled from,
  // when source_kind='document'); scope by joining that to documents.source_id.
  // A take whose source_ref isn't a document of a listed tenant is excluded
  // fail-closed — the same posture mig 047 takes for unclassified rows.
  const sources = normalizeSourceIds(opts.sourceIds);
  const params: unknown[] = [status, n];
  let sourceFilter = "";
  if (sources) {
    params.push(sources);
    sourceFilter = ` AND EXISTS (
          SELECT 1 FROM documents d
           WHERE d.id = synth_takes.source_ref
             AND d.source_id = ANY($${params.length}::text[])
        )`;
  }
  try {
    const r = await engine.query<TakeRow>(
      `SELECT take_key, claim_text, kind, weight, domain, status,
              generated_at::text AS generated_at
         FROM synth_takes
        WHERE ($1::text IS NULL OR status = $1)${sourceFilter}
        ORDER BY generated_at DESC, take_key ASC
        LIMIT $2`,
      params,
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

/**
 * @param sourceIds Accepted for API symmetry but NOT applied: the calibration
 *   profile is a single GLOBAL scorecard per run (migration 045 has no
 *   `source_id` on `synth_calibration_profile`), so there is no per-tenant axis
 *   to filter on. Passing it is a no-op.
 */
export async function getCalibrationProfile(
  engine: Engine,
  _sourceIds?: string[],
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
