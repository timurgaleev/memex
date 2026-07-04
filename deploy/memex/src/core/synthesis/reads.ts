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

export interface TakeSearchRow {
  take_key: string;
  claim_text: string;
  kind: string;
  weight: number;
  domain: string | null;
  status: string;
}

/**
 * Fuzzy claim search over `synth_takes`. Ranks by pg_trgm `similarity()` and
 * falls back to a substring match so a short query still recalls its exact
 * phrase. Uses the `similarity()` FUNCTION with an explicit threshold rather
 * than the `%` operator, since there is no trigram GIN index to back the
 * operator (same choice as slug resolution). Tenant scope mirrors `listTakes`:
 * a scoped caller only sees takes whose source document is one of theirs,
 * fail-closed. Fail-open to empty on a pre-045 brain.
 */
export async function searchTakes(
  engine: Engine,
  opts: { q: string; limit?: number; sourceIds?: string[] },
): Promise<TakeSearchRow[]> {
  const q = typeof opts.q === "string" ? opts.q.trim() : "";
  if (q.length === 0) return [];
  const n = clampLimit(opts.limit, 200, 50);
  const sources = normalizeSourceIds(opts.sourceIds);
  const params: unknown[] = [q, n];
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
    const r = await engine.query<TakeSearchRow>(
      `SELECT take_key, claim_text, kind, weight, domain, status
         FROM synth_takes
        WHERE (similarity(claim_text, $1) >= 0.3 OR claim_text ILIKE '%' || $1 || '%')${sourceFilter}
        ORDER BY similarity(claim_text, $1) DESC, take_key ASC
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
  source_id: string;
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
 * Latest calibration profile the caller is allowed to see. Migration 060 added
 * the `source_id` axis, so profiles are per-tenant: a scoped caller filters to
 * their effective read source set (`source_id = ANY($allowed)`), which excludes
 * every other tenant's profile fail-closed — the same posture the other scoped
 * reads take. `undefined`/empty leaves it unscoped (admin/internal), returning
 * the newest profile across all tenants.
 */
export async function getCalibrationProfile(
  engine: Engine,
  sourceIds?: string[],
): Promise<CalibrationProfileRow | null> {
  const sources = normalizeSourceIds(sourceIds);
  const params: unknown[] = [];
  let sourceFilter = "";
  if (sources) {
    params.push(sources);
    sourceFilter = ` WHERE source_id = ANY($${params.length}::text[])`;
  }
  try {
    const r = await engine.query<CalibrationProfileRow>(
      `SELECT generated_at::text AS generated_at, source_id, total_graded, correct,
              incorrect, partial, unresolvable, accuracy,
              pattern_statements, bias_tags, model_id
         FROM synth_calibration_profile${sourceFilter}
        ORDER BY generated_at DESC
        LIMIT 1`,
      params,
    );
    return r.rows[0] ?? null;
  } catch {
    return null;
  }
}
