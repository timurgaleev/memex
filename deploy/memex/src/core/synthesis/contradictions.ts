/**
 * Latent-contradiction probe (Item 3) — a paid, default-OFF Sonnet cycle phase
 * that judges pairs of facts that plausibly conflict and records the SUSPECTED
 * contradictions in `synth_contradictions` (migration 064). This is the
 * LLM-derived complement to the deterministic `contradicts` graph edges the
 * `find_contradictions` tool reads: the graph surfaces conflicts an author
 * asserted; this surfaces conflicts the probe suspects.
 *
 * Architecture guard: reads entity_facts, writes ONLY to synth_contradictions.
 * A finding is advisory — it never mutates a fact, take, or edge.
 *
 * Safety: opt-in (`MEMEX_PROBE_CONTRADICTIONS=1`); paired candidates are
 * date-pre-filtered (a lookback window) and hard-capped (`maxPairs`) BEFORE any
 * LLM call; budget-capped (BudgetTracker with a pre-call wouldExceed gate);
 * cached (a pair already judged under this prompt_version is skipped — no
 * re-spend); fail-open (a per-pair judge/parse error is collected + skipped).
 * Sonnet injected via `sonnetFn`; NO live Bedrock in tests.
 */
import { createHash } from "node:crypto";
import type { Engine } from "../engine/interface.ts";
import { resolveSonnetFn, resolveFactsModel, type SonnetFn, type SonnetUsage } from "../llm/sonnet.ts";
import { sanitizeForPrompt } from "../llm/sanitize.ts";
import { BudgetTracker, BudgetExhausted } from "../budget.ts";

export const PROBE_CONTRADICTIONS_PROMPT_VERSION = "v1-sonnet";

const DEFAULT_MAX_PAIRS = 40;
const DEFAULT_LOOKBACK_DAYS = 365;
const DEFAULT_BUDGET_USD = 1.0;
const SEVERITIES = ["low", "medium", "high"] as const;
type Severity = (typeof SEVERITIES)[number];

/** A candidate pair of claims about the same entity. */
export interface CandidatePair {
  a_ref: string;
  a_text: string;
  b_ref: string;
  b_text: string;
  source_id: string | null;
}

export interface ProbeContradictionsOptions {
  /** Injected Sonnet seam (tests). Default: the real Bedrock callSonnet. */
  sonnetFn?: SonnetFn;
  modelId?: string;
  /** Hard cap on judged pairs per run (bounds spend). Default 40. */
  maxPairs?: number;
  /** Only pair facts written within this many days. Default 365. */
  lookbackDays?: number;
  /** Shared USD budget. Default: a fresh cap from env. */
  budget?: BudgetTracker;
  /** Test seam — inject candidate pairs. Default: same-entity fact pairs. */
  pairsFn?: (engine: Engine, maxPairs: number, lookbackDays: number) => Promise<CandidatePair[]>;
  promptVersion?: string;
}

export interface ProbeContradictionsResult {
  pairsScanned: number;
  judged: number;
  contradictionsFound: number;
  cacheHits: number;
  budgetExhausted: boolean;
  /** Set when the phase was a clean no-op (default-OFF) rather than a failure. */
  skippedReason?: string;
  errors: string[];
}

const JUDGE_SYSTEM_PROMPT = `You compare two claims (A and B) recorded about the
SAME entity in a personal knowledge brain and decide whether they CONTRADICT —
i.e. they cannot both be true of the same subject at the same time. A later
claim that simply SUPERSEDES an earlier one (a value that changed over time) is
NOT a contradiction unless both are asserted as currently true.

Output ONLY one JSON object:
  {"contradicts": (true|false),
   "severity": ("low"|"medium"|"high"),
   "axis": (<=40 chars naming what they disagree on, e.g. "timing","value","stance"),
   "confidence": (0..1),
   "resolution_command": (<=120 chars; a short suggestion, or "")}

If they are compatible or merely a time-ordered update, return contradicts=false.`;

/** Deterministic idempotency key: hash(a_ref + b_ref + prompt_version). */
export function pairKey(aRef: string, bRef: string, promptVersion: string): string {
  return createHash("sha256").update(`${aRef}\u0000${bRef}\u0000${promptVersion}`).digest("hex");
}

/** Estimate one judge call's usage for the pre-call budget gate, from the actual
 *  prompt size (~4 chars/token) so a large claim pair can't slip past a thin budget. */
function estimatePairUsage(a: string, b: string): SonnetUsage {
  const inputChars = JUDGE_SYSTEM_PROMPT.length + a.length + b.length + 64;
  return { inputTokens: Math.ceil(inputChars / 4), outputTokens: 200 };
}

export interface ParsedJudgment {
  contradicts: boolean;
  severity: Severity;
  axis: string;
  confidence: number;
  resolution_command: string;
}

/** Parse a single judgment object. Tolerant; returns null on failure. */
export function parseJudgment(raw: string): ParsedJudgment | null {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence && fence[1] !== undefined) text = fence[1].trim();
  const start = text.indexOf("{");
  if (start === -1) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start));
  } catch {
    const end = text.lastIndexOf("}");
    if (end === -1) return null;
    try {
      parsed = JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const o = parsed as Record<string, unknown>;
  if (typeof o.contradicts !== "boolean") return null;
  const severity: Severity = (SEVERITIES as readonly string[]).includes(String(o.severity))
    ? (o.severity as Severity)
    : "low";
  const cRaw = typeof o.confidence === "number" ? o.confidence : Number.parseFloat(String(o.confidence ?? ""));
  const confidence = Number.isFinite(cRaw) ? Math.max(0, Math.min(1, cRaw)) : 0;
  const axis = typeof o.axis === "string" ? o.axis.slice(0, 40) : "";
  const resolution_command = typeof o.resolution_command === "string" ? o.resolution_command.slice(0, 120) : "";
  return { contradicts: o.contradicts, severity, axis, confidence, resolution_command };
}

/**
 * Default candidate generator — pairs of DISTINCT facts sharing an entity_slug,
 * both written within the lookback window. Same-entity facts are the natural
 * conflict locus (two claims about one subject). Bounded by maxPairs at the SQL
 * layer so we never materialize the full O(n^2) product. Fail-soft to [].
 */
async function defaultPairs(
  engine: Engine,
  maxPairs: number,
  lookbackDays: number,
): Promise<CandidatePair[]> {
  try {
    const { rows } = await engine.query<CandidatePair>(
      `SELECT f1.id::text AS a_ref, f1.fact AS a_text,
              f2.id::text AS b_ref, f2.fact AS b_text,
              f1.source_id AS source_id
         FROM entity_facts f1
         JOIN entity_facts f2
           ON f2.entity_slug = f1.entity_slug
          AND f2.id > f1.id
          AND f2.fact <> f1.fact
          -- Same-tenant only: never pair two tenants' facts that share a slug
          -- (e.g. both hold people/alice-smith), which would leak one tenant's
          -- private fact text into the other's find_contradictions read.
          AND f2.source_id IS NOT DISTINCT FROM f1.source_id
        WHERE f1.written_at >= now() - ($1 * interval '1 day')
          AND f2.written_at >= now() - ($1 * interval '1 day')
        ORDER BY f1.entity_slug ASC, f1.id ASC, f2.id ASC
        LIMIT $2`,
      [lookbackDays, maxPairs],
    );
    return rows;
  } catch {
    return [];
  }
}

function probeEnabled(): boolean {
  const v = (process.env.MEMEX_PROBE_CONTRADICTIONS ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
}

function defaultBudget(): number {
  const raw = (process.env.MEMEX_PROBE_CONTRADICTIONS_BUDGET_USD ?? "").trim();
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_BUDGET_USD;
}

/**
 * Run the probe. Default-OFF: a live (paid) run needs MEMEX_PROBE_CONTRADICTIONS=1;
 * tests inject a sonnetFn (bypasses the gate, no spend).
 */
export async function probeContradictionsPhase(
  engine: Engine,
  opts: ProbeContradictionsOptions = {},
): Promise<ProbeContradictionsResult> {
  const result: ProbeContradictionsResult = {
    pairsScanned: 0,
    judged: 0,
    contradictionsFound: 0,
    cacheHits: 0,
    budgetExhausted: false,
    errors: [],
  };
  if (!opts.sonnetFn && !probeEnabled()) {
    result.skippedReason = "default-OFF: set MEMEX_PROBE_CONTRADICTIONS=1 to run the paid probe";
    return result;
  }

  const maxPairs = opts.maxPairs ?? DEFAULT_MAX_PAIRS;
  const lookbackDays = opts.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  const promptVersion = opts.promptVersion ?? PROBE_CONTRADICTIONS_PROMPT_VERSION;
  const budget = opts.budget ?? new BudgetTracker(defaultBudget(), "probe-contradictions");
  const probeModel = resolveFactsModel(opts.modelId);
  const sonnetFn = resolveSonnetFn(opts.sonnetFn, { modelId: probeModel });
  const pairsFn = opts.pairsFn ?? defaultPairs;

  const pairs = await pairsFn(engine, maxPairs, lookbackDays);
  result.pairsScanned = pairs.length;

  for (const pair of pairs) {
    const key = pairKey(pair.a_ref, pair.b_ref, promptVersion);

    // Cache: already judged under this prompt version → skip (no re-spend).
    try {
      const { rows: existing } = await engine.query<{ id: number }>(
        `SELECT id FROM synth_contradictions WHERE pair_key = $1`,
        [key],
      );
      if (existing.length > 0) {
        result.cacheHits += 1;
        continue;
      }
    } catch (e) {
      result.errors.push(`pair ${pair.a_ref}/${pair.b_ref} cache check: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }

    // Budget pre-flight — stop the whole phase once a pair can't be afforded.
    if (budget.wouldExceed(probeModel, estimatePairUsage(pair.a_text, pair.b_text))) {
      result.budgetExhausted = true;
      break;
    }

    let judgment: ParsedJudgment | null;
    let usedModel: string;
    let overCap = false;
    try {
      const resp = await sonnetFn({
        system: JUDGE_SYSTEM_PROMPT,
        user: `A: ${sanitizeForPrompt(pair.a_text).text}\n\nB: ${sanitizeForPrompt(pair.b_text).text}`,
        maxTokens: 250,
        temperature: 0,
      });
      usedModel = resp.modelId;
      try {
        budget.record(resp.modelId, resp.usage);
      } catch (e) {
        if (e instanceof BudgetExhausted) {
          result.budgetExhausted = true;
          overCap = true;
        } else {
          throw e;
        }
      }
      judgment = parseJudgment(resp.text);
    } catch (e) {
      result.errors.push(`pair ${pair.a_ref}/${pair.b_ref} judge: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    result.judged += 1;

    // Only a SUSPECTED contradiction is stored (a false judgment is not noise
    // worth persisting; the cache is the pair_key existence, so a non-storing
    // pass will be re-judged next run — acceptable, it is the negative case).
    if (judgment && judgment.contradicts) {
      try {
        await engine.query(
          `INSERT INTO synth_contradictions
             (pair_key, a_ref, a_kind, a_text, b_ref, b_kind, b_text,
              severity, axis, confidence, resolution_command, source_id, prompt_version, model_id)
           VALUES ($1, $2, 'fact', $3, $4, 'fact', $5, $6, $7, $8, $9, $10, $11, $12)
           ON CONFLICT (pair_key) DO NOTHING`,
          [
            key, pair.a_ref, pair.a_text, pair.b_ref, pair.b_text,
            judgment.severity, judgment.axis, judgment.confidence, judgment.resolution_command,
            pair.source_id, promptVersion, usedModel,
          ],
        );
        result.contradictionsFound += 1;
      } catch (e) {
        result.errors.push(`pair ${pair.a_ref}/${pair.b_ref} write: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    if (overCap) break; // this call tipped the ceiling — stop.
  }

  return result;
}
