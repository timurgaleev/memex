/**
 * calibration_profile synthesis phase — a narrative bias/calibration profile,
 * written ONLY to `synth_calibration_profile`. Reads `synth_take_grades`; never
 * touches authored notes.
 *
 * Aggregates the resolved take-grade subset into a scorecard (counts + accuracy)
 * and asks Claude Haiku for 2-4 plain-language pattern statements + a few kebab-case
 * bias tags. The narrative is advisory output, recorded with provenance (the
 * graded take ids), generated_at, and model_id.
 *
 * Safety: opt-in; one LLM call per run (cost guard is the call count, not a
 * per-item loop); idempotent in the sense that it appends an immutable
 * history row each run (a profile is a point-in-time snapshot, not a mutable
 * record) and skips entirely when there is too little graded data; fail-open
 * (an LLM error falls back to a deterministic template, never aborts).
 */
import type { Engine } from "../engine/interface.ts";
import { resolveLlmFn, type LlmFn } from "../llm/haiku.ts";

export const CALIBRATION_PROMPT_VERSION = "v1-nova";

/** Minimum graded takes before a profile is meaningful. */
const MIN_GRADED = 5;

export interface CalibrationProfileOptions {
  llmFn?: LlmFn;
  modelId?: string;
  /** Override the minimum-graded gate (tests). */
  minGraded?: number;
}

export interface CalibrationProfileResult {
  profileWritten: boolean;
  totalGraded: number;
  accuracy: number | null;
  patternStatements: string[];
  biasTags: string[];
  skippedReason?: string;
  errors: string[];
}

interface Scorecard {
  total: number;
  correct: number;
  incorrect: number;
  partial: number;
  unresolvable: number;
  accuracy: number | null;
  gradedTakeIds: number[];
}

const PATTERNS_SYSTEM_PROMPT = `You summarize a forecaster's track record so they
can see their patterns. Below is a JSON scorecard over their resolved takes.

Write 2 to 4 short pattern statements, ONE per line. Each statement names a
direction (right / wrong / over-confident / under-calibrated), includes one
concrete number, and sounds like a smart friend recapping the record. Under 25
words each. No "the data shows", no jargon.

Output the 2-4 statements only, one per line. No numbering, no surrounding prose.`;

const BIAS_TAGS_SYSTEM_PROMPT = `From the pattern statements below, emit 1-4
kebab-case bias tags combining an axis (over-confident, under-confident, early,
late, well-calibrated) with a domain. Examples: "over-confident-macro",
"well-calibrated-on-tactics".

Output ONLY a JSON array of strings. If no clear pattern, return [].`;

/** Most-recent grade per take, then tally. Pure aggregation over rows. */
function buildScorecard(
  rows: Array<{ take_id: number; verdict: string }>,
): Scorecard {
  // One verdict per take — the query already returns the latest per take.
  let correct = 0;
  let incorrect = 0;
  let partial = 0;
  let unresolvable = 0;
  const ids: number[] = [];
  for (const r of rows) {
    ids.push(Number(r.take_id));
    switch (r.verdict) {
      case "correct":
        correct += 1;
        break;
      case "incorrect":
        incorrect += 1;
        break;
      case "partial":
        partial += 1;
        break;
      default:
        unresolvable += 1;
    }
  }
  const resolved = correct + incorrect + partial;
  const accuracy = resolved > 0 ? (correct + 0.5 * partial) / resolved : null;
  return {
    total: rows.length,
    correct,
    incorrect,
    partial,
    unresolvable,
    accuracy,
    gradedTakeIds: ids,
  };
}

/** Parse newline-separated pattern statements. */
export function parsePatternStatements(raw: string): string[] {
  if (!raw || raw.trim().length === 0) return [];
  return raw
    .split("\n")
    .map((l) => l.trim().replace(/^[-*•]\s+|^\d+[.)]\s+/, ""))
    .filter((l) => l.length > 0 && l.length <= 200)
    .slice(0, 4);
}

/** Parse a JSON-array of kebab-case bias tags. Tolerant; never throws. */
export function parseBiasTags(raw: string): string[] {
  if (!raw || raw.trim().length === 0) return [];
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence && fence[1] !== undefined) text = fence[1].trim();
  const start = text.indexOf("[");
  if (start === -1) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((t): t is string => typeof t === "string")
    .map((t) => t.trim().toLowerCase())
    .filter((t) => /^[a-z]+(?:-[a-z0-9]+)*$/.test(t))
    .slice(0, 4);
}

/** Deterministic fallback when the LLM is unavailable. */
function templatePatterns(s: Scorecard): string[] {
  const resolved = s.correct + s.incorrect + s.partial;
  if (resolved === 0) return ["Not enough resolved takes to read a pattern yet."];
  const acc = s.accuracy !== null ? Math.round(s.accuracy * 100) : 0;
  return [`Overall ${acc}% accurate across ${resolved} resolved takes (${s.correct} right, ${s.incorrect} wrong).`];
}

export async function calibrationProfilePhase(
  engine: Engine,
  opts: CalibrationProfileOptions = {},
): Promise<CalibrationProfileResult> {
  const minGraded = opts.minGraded ?? MIN_GRADED;
  const llm = resolveLlmFn(opts.llmFn, opts.modelId ? { modelId: opts.modelId } : {});
  const result: CalibrationProfileResult = {
    profileWritten: false,
    totalGraded: 0,
    accuracy: null,
    patternStatements: [],
    biasTags: [],
    errors: [],
  };

  // Latest grade per take (highest grade id wins on re-grade).
  const { rows } = await engine.query<{ take_id: number; verdict: string }>(
    `SELECT DISTINCT ON (g.take_id) g.take_id, g.verdict
       FROM synth_take_grades g
      ORDER BY g.take_id, g.id DESC`,
  );
  const scorecard = buildScorecard(rows);
  result.totalGraded = scorecard.total;
  result.accuracy = scorecard.accuracy;

  if (scorecard.total < minGraded) {
    result.skippedReason = "insufficient_data";
    return result;
  }

  let patternStatements = templatePatterns(scorecard);
  let biasTags: string[] = [];
  let modelId = opts.modelId ?? "deterministic";

  try {
    const resp = await llm({
      system: PATTERNS_SYSTEM_PROMPT,
      user: JSON.stringify(
        {
          total: scorecard.total,
          correct: scorecard.correct,
          incorrect: scorecard.incorrect,
          partial: scorecard.partial,
          unresolvable: scorecard.unresolvable,
          accuracy: scorecard.accuracy,
        },
        null,
        2,
      ),
      maxTokens: 400,
    });
    const parsed = parsePatternStatements(resp.text);
    if (parsed.length > 0) {
      patternStatements = parsed;
      modelId = resp.modelId;
    }
  } catch (e) {
    // Fail-open: keep the template patterns.
    result.errors.push(`patterns: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (patternStatements.length > 0) {
    try {
      // Indirect chain: corpus -> Haiku (patterns) -> here -> Haiku (bias tags).
      // The patterns are length-clamped (<=200 chars, <=4 items) but otherwise
      // unsanitized. Acceptable because the only sink is the bias_tags JSONB in
      // synth_calibration_profile — write-only, never executed or reflected to a
      // caller. parseBiasTags additionally accepts only kebab-case tokens.
      const resp = await llm({
        system: BIAS_TAGS_SYSTEM_PROMPT,
        user: patternStatements.map((p) => `- ${p}`).join("\n"),
        maxTokens: 120,
      });
      biasTags = parseBiasTags(resp.text);
    } catch (e) {
      result.errors.push(`bias_tags: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  result.patternStatements = patternStatements;
  result.biasTags = biasTags;

  try {
    await engine.query(
      `INSERT INTO synth_calibration_profile
         (generated_at, total_graded, correct, incorrect, partial, unresolvable,
          accuracy, graded_take_ids, pattern_statements, bias_tags, model_id)
       VALUES (now(), $1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10)`,
      [
        scorecard.total,
        scorecard.correct,
        scorecard.incorrect,
        scorecard.partial,
        scorecard.unresolvable,
        scorecard.accuracy,
        JSON.stringify(scorecard.gradedTakeIds),
        JSON.stringify(patternStatements),
        JSON.stringify(biasTags),
        modelId,
      ],
    );
    result.profileWritten = true;
  } catch (e) {
    result.errors.push(`profile write: ${e instanceof Error ? e.message : String(e)}`);
  }

  return result;
}
