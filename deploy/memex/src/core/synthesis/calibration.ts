/**
 * calibration_profile synthesis phase — a narrative bias/calibration profile,
 * written ONLY to `synth_calibration_profile`. Reads `synth_take_grades`; never
 * touches authored notes.
 *
 * Grades are grouped by the owning tenant (`source_id`, derived from the take's
 * source document) and each tenant with enough graded takes gets its OWN
 * scorecard + profile row — a source-scoped caller never sees a figure blended
 * from another tenant's track record. Each per-source scorecard (counts +
 * accuracy) is turned into 2-4 plain-language pattern statements + a few
 * kebab-case bias tags via Claude Haiku, recorded with provenance (the graded
 * take ids), generated_at, source_id, and model_id.
 *
 * Safety: opt-in; the LLM call budget is bounded by the number of tenants with
 * gradable data (one or two Haiku calls per source, not a per-item loop);
 * idempotent in the sense that it appends an immutable history row per source
 * each run (a profile is a point-in-time snapshot, not a mutable record) and
 * skips any source with too little graded data; fail-open (an LLM error falls
 * back to a deterministic template, never aborts).
 */
import type { Engine } from "../engine/interface.ts";
import { resolveLlmFn, type LlmFn } from "../llm/haiku.ts";

export const CALIBRATION_PROMPT_VERSION = "v1-nova";

/** Minimum graded takes before a profile is meaningful. */
const MIN_GRADED = 5;

/**
 * Legacy tenant bucket. Grades whose take resolves to an unclassified (NULL
 * source_id) or vanished source document land here — the same 'default' legacy
 * tenant migration 047 backfills content rows to. A source-scoped remote tenant
 * never has 'default' in its allowed set, so this bucket stays private to the
 * default holder.
 */
const DEFAULT_SOURCE_ID = "default";

export interface CalibrationProfileOptions {
  llmFn?: LlmFn;
  modelId?: string;
  /** Override the minimum-graded gate (tests). */
  minGraded?: number;
}

/** One tenant's outcome within a calibration run. */
export interface CalibrationSourceProfile {
  sourceId: string;
  profileWritten: boolean;
  totalGraded: number;
  accuracy: number | null;
  patternStatements: string[];
  biasTags: string[];
  skippedReason?: string;
}

export interface CalibrationProfileResult {
  /** True when at least one source profile was written. */
  profileWritten: boolean;
  /** Grades considered across every source this run. */
  totalGraded: number;
  /** Pooled accuracy across every written source (single-source: that source's). */
  accuracy: number | null;
  /** Single-source runs mirror the sole profile here; multi-source: see `profiles`. */
  patternStatements: string[];
  biasTags: string[];
  /** Set to "insufficient_data" only when NO source cleared the min-graded gate. */
  skippedReason?: string;
  /** Per-tenant breakdown. */
  profiles: CalibrationSourceProfile[];
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

/** Bucket the latest-per-take grades by their owning tenant. */
function groupGradesBySource(
  rows: Array<{ take_id: number; verdict: string; source_id: string | null }>,
): Map<string, Array<{ take_id: number; verdict: string }>> {
  const groups = new Map<string, Array<{ take_id: number; verdict: string }>>();
  for (const r of rows) {
    const key =
      typeof r.source_id === "string" && r.source_id.length > 0
        ? r.source_id
        : DEFAULT_SOURCE_ID;
    let bucket = groups.get(key);
    if (!bucket) {
      bucket = [];
      groups.set(key, bucket);
    }
    bucket.push({ take_id: Number(r.take_id), verdict: r.verdict });
  }
  return groups;
}

/**
 * Turn a scorecard into pattern statements + bias tags via two Haiku calls.
 * Fail-open: an LLM error keeps the deterministic template and records the
 * error; the caller still writes a profile.
 */
async function generateNarrative(
  llm: LlmFn,
  scorecard: Scorecard,
  fallbackModelId: string,
  errors: string[],
  errorPrefix: string,
): Promise<{ patternStatements: string[]; biasTags: string[]; modelId: string }> {
  let patternStatements = templatePatterns(scorecard);
  let biasTags: string[] = [];
  let modelId = fallbackModelId;

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
    errors.push(`${errorPrefix}patterns: ${e instanceof Error ? e.message : String(e)}`);
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
      errors.push(`${errorPrefix}bias_tags: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return { patternStatements, biasTags, modelId };
}

/** Append one immutable profile snapshot for a tenant. */
async function writeProfileRow(
  engine: Engine,
  sourceId: string,
  scorecard: Scorecard,
  patternStatements: string[],
  biasTags: string[],
  modelId: string,
): Promise<void> {
  await engine.query(
    `INSERT INTO synth_calibration_profile
       (generated_at, source_id, total_graded, correct, incorrect, partial,
        unresolvable, accuracy, graded_take_ids, pattern_statements, bias_tags, model_id)
     VALUES (now(), $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11)`,
    [
      sourceId,
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
}

export async function calibrationProfilePhase(
  engine: Engine,
  opts: CalibrationProfileOptions = {},
): Promise<CalibrationProfileResult> {
  const minGraded = opts.minGraded ?? MIN_GRADED;
  const llm = resolveLlmFn(opts.llmFn, opts.modelId ? { modelId: opts.modelId } : {});
  const fallbackModelId = opts.modelId ?? "deterministic";
  const result: CalibrationProfileResult = {
    profileWritten: false,
    totalGraded: 0,
    accuracy: null,
    patternStatements: [],
    biasTags: [],
    profiles: [],
    errors: [],
  };

  // Latest grade per take (highest grade id wins on re-grade), carrying the
  // owning tenant via the take's source document. A take whose source_ref has
  // no matching document (unclassified / deleted) coalesces to the default
  // tenant so it is still counted for the default holder — the same fail-open
  // bucket the phase used before the source_id axis existed.
  const { rows } = await engine.query<{
    take_id: number;
    verdict: string;
    source_id: string | null;
  }>(
    `SELECT DISTINCT ON (g.take_id)
            g.take_id, g.verdict, COALESCE(d.source_id, $1) AS source_id
       FROM synth_take_grades g
       JOIN synth_takes t ON t.id = g.take_id
       LEFT JOIN documents d ON d.id = t.source_ref
      ORDER BY g.take_id, g.id DESC`,
    [DEFAULT_SOURCE_ID],
  );

  const groups = groupGradesBySource(rows);
  // Deterministic order keeps multi-source runs stable.
  const sourceIds = Array.from(groups.keys()).sort();

  let pooledCorrect = 0;
  let pooledPartial = 0;
  let pooledResolved = 0;

  for (const sourceId of sourceIds) {
    const scorecard = buildScorecard(groups.get(sourceId) ?? []);
    result.totalGraded += scorecard.total;
    const per: CalibrationSourceProfile = {
      sourceId,
      profileWritten: false,
      totalGraded: scorecard.total,
      accuracy: scorecard.accuracy,
      patternStatements: [],
      biasTags: [],
    };

    if (scorecard.total < minGraded) {
      per.skippedReason = "insufficient_data";
      result.profiles.push(per);
      continue;
    }

    const { patternStatements, biasTags, modelId } = await generateNarrative(
      llm,
      scorecard,
      fallbackModelId,
      result.errors,
      `${sourceId}: `,
    );
    per.patternStatements = patternStatements;
    per.biasTags = biasTags;

    try {
      await writeProfileRow(engine, sourceId, scorecard, patternStatements, biasTags, modelId);
      per.profileWritten = true;
      result.profileWritten = true;
      pooledCorrect += scorecard.correct;
      pooledPartial += scorecard.partial;
      pooledResolved += scorecard.correct + scorecard.incorrect + scorecard.partial;
    } catch (e) {
      result.errors.push(`${sourceId}: profile write: ${e instanceof Error ? e.message : String(e)}`);
    }
    result.profiles.push(per);
  }

  result.accuracy =
    pooledResolved > 0 ? (pooledCorrect + 0.5 * pooledPartial) / pooledResolved : null;

  // Single-tenant contract: when exactly one profile is written, surface it at
  // the top level so existing single-holder callers read the same fields.
  const written = result.profiles.filter((p) => p.profileWritten);
  if (written.length === 1 && written[0]) {
    result.patternStatements = written[0].patternStatements;
    result.biasTags = written[0].biasTags;
  }
  if (!result.profileWritten) {
    result.skippedReason = "insufficient_data";
  }

  return result;
}
