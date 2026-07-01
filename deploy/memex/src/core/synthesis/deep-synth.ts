/**
 * deep-synth — a slower, opt-in Sonnet synthesis CADENCE distinct from the Nova
 * dream-synthesis tick (atoms→concepts→takes, MEMEX_DREAM_SYNTHESIS). Where that
 * chain DERIVES structure with cheap Nova Lite, deep-synth runs the paid S2
 * `runThink` pipeline (GATHER → SYNTHESIZE) over a small set of standing
 * questions and REPORTS across the corpus with citations.
 *
 * Standing questions: supplied explicitly, else the top `synth_concepts` titles
 * (memex's own primitive — listConcepts) treated as questions. This mirrors the
 * reference's auto-think dream phase, which runs `think` over a configured
 * `questions[]` list, budget-capped, default-OFF, and (by default) returns/stages
 * the syntheses rather than committing them. Adapted from the reference cycle's
 * auto-think phase (core/cycle/auto-think.ts:94 runPhaseAutoThink) — the config
 * store is replaced by memex's synth_concepts read, and the reference's external
 * BudgetMeter is replaced by memex's BudgetTracker driven through a recording
 * wrapper so the SHARED cap holds across every question without touching runThink.
 *
 * memex stance: synthesis READS the corpus + synth_* store; it writes NOTHING
 * back here — the syntheses are RETURNED. No new schema, no migration. A caller
 * (the cycle) decides what, if anything, to persist. Opt-in (MEMEX_DEEP_SYNTH),
 * USD-budget-capped, Sonnet injected via `sonnetFn`; NO live Bedrock in tests.
 */
import type { Storage } from "../storage.ts";
import type { SearchHit } from "../search/hybrid.ts";
import type { SonnetFn } from "../llm/sonnet.ts";
import { DEFAULT_SONNET_MODEL } from "../llm/sonnet.ts";
import { resolveSonnetFn } from "../llm/sonnet.ts";
import { BudgetTracker, BudgetExhausted } from "../budget.ts";
import type { SonnetUsage } from "../llm/sonnet.ts";
import { runThink, type ThinkSynthesis } from "./think.ts";
import { listConcepts } from "./reads.ts";

export const DEEP_SYNTH_PROMPT_VERSION = "v1-sonnet";

const DEFAULT_MAX_QUESTIONS = 5;
const DEFAULT_BUDGET_USD = 1.0;
/** Per-question output-token cap for the pre-flight estimate — matches runThink's
 *  DEFAULT_OUTPUT_TOKENS so the guard prices the same envelope the call uses. */
const ESTIMATE_OUTPUT_TOKENS = 1500;
/** Conservative input-side allowance (chars) for the pre-flight budget guard:
 *  the think system prompt + a full <pages>/<takes> evidence blob. ~5K tokens at
 *  ~4 chars/token, mirroring the reference auto-think's 5K-input estimate. A
 *  fixed floor so a near-empty budget can't slip one more paid question past. */
const ESTIMATE_INPUT_CHARS = 20_000;

export interface DeepSynthItem {
  question: string;
  synthesis: ThinkSynthesis;
  pagesGathered: number;
  takesGathered: number;
}

export interface DeepSynthOptions {
  /** Standing questions to synthesize. Default: top synth_concepts titles. */
  questions?: string[];
  /** Max questions per run (default 5; MEMEX_DEEP_SYNTH_MAX_QUESTIONS overrides). */
  maxQuestions?: number;
  /** USD ceiling for the whole run (default 1.0; MEMEX_DEEP_SYNTH_BUDGET_USD). */
  maxBudgetUsd?: number;
  /** Shared budget across questions. Default: a fresh cap from maxBudgetUsd/env. */
  budget?: BudgetTracker;
  /** Test seam — inject a fake model; bypasses the live-run env gate. */
  sonnetFn?: SonnetFn;
  modelId?: string;
  /** Page hits to gather per question (forwarded to runThink). */
  k?: number;
  /**
   * Test seam — inject the page retriever. hybridSearch has no offline
   * query-embedder, so tests supply a deterministic fake here (as in think.ts)
   * rather than hit Bedrock.
   */
  pagesFn?: (question: string, k: number) => Promise<SearchHit[]>;
}

export interface DeepSynthResult {
  ran: boolean;
  reason?: string;
  /** Standing questions actually dispatched (may be < available on budget-out). */
  questionsAsked: number;
  /** One entry per question that produced a non-empty synthesis. */
  syntheses: DeepSynthItem[];
  spentUsd: number;
  budgetExhausted: boolean;
}

function liveEnabled(): boolean {
  const v = (process.env["MEMEX_DEEP_SYNTH"] ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
}

function defaultBudget(): number {
  const raw = (process.env["MEMEX_DEEP_SYNTH_BUDGET_USD"] ?? "").trim();
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_BUDGET_USD;
}

function defaultMaxQuestions(): number {
  const raw = (process.env["MEMEX_DEEP_SYNTH_MAX_QUESTIONS"] ?? "").trim();
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 50 ? n : DEFAULT_MAX_QUESTIONS;
}

/** Worst-case usage for the per-question pre-call budget gate, derived from a
 *  fixed evidence allowance + the question text (~4 chars/token). */
function estimateUsage(question: string): SonnetUsage {
  return {
    inputTokens: Math.ceil((ESTIMATE_INPUT_CHARS + question.length) / 4),
    outputTokens: ESTIMATE_OUTPUT_TOKENS,
  };
}

/**
 * Derive standing questions from the top synth_concepts titles (by atom_count).
 * Deterministic, no LLM. Fail-open to [] on a pre-045 brain (listConcepts already
 * swallows the missing-table error). Blank titles are dropped.
 */
async function deriveStandingQuestions(
  storage: Storage,
  limit: number,
): Promise<string[]> {
  const concepts = await listConcepts(storage.engine(), limit);
  return concepts
    .map((c) => (typeof c.title === "string" ? c.title.trim() : ""))
    .filter((t) => t.length > 0)
    .slice(0, limit);
}

/**
 * Run one deep-synthesis cadence pass. Default-OFF: a live (paid) run needs
 * MEMEX_DEEP_SYNTH=1; tests inject a sonnetFn, which both bypasses the gate and
 * avoids spend. The phase owns ONE BudgetTracker shared across every question:
 * a `wouldExceed` pre-flight skips a question that can't be afforded, and a
 * recording wrapper around the model seam charges each real call to that shared
 * cap (so runThink stays untouched). Fail-open: a question whose synthesis is
 * empty or whose model call errors is skipped, not thrown.
 */
export async function runDeepSynthPhase(
  storage: Storage,
  opts: DeepSynthOptions = {},
): Promise<DeepSynthResult> {
  if (!opts.sonnetFn && !liveEnabled()) {
    return blank("default-OFF: set MEMEX_DEEP_SYNTH=1 to run paid Sonnet deep synthesis");
  }

  const maxQuestions = opts.maxQuestions ?? defaultMaxQuestions();
  const supplied = (opts.questions ?? [])
    .map((q) => (typeof q === "string" ? q.trim() : ""))
    .filter((q) => q.length > 0);
  const questions = (
    supplied.length > 0 ? supplied : await deriveStandingQuestions(storage, maxQuestions)
  ).slice(0, maxQuestions);

  if (questions.length === 0) {
    return { ...blank("no standing questions (empty synth_concepts and none supplied)"), ran: true };
  }

  const modelId = opts.modelId ?? process.env["MEMEX_FACTS_MODEL"] ?? DEFAULT_SONNET_MODEL;
  const budget = opts.budget ?? new BudgetTracker(opts.maxBudgetUsd ?? defaultBudget(), "deep-synth");

  // Recording wrapper: charge each real (paid) call to the SHARED phase budget
  // AFTER it returns, so the cap holds across questions without editing runThink.
  // A ceiling hit is captured (not rethrown) so the current synthesis is still
  // returned and the loop stops cleanly on the next iteration.
  let budgetHit = false;
  const baseSonnet = resolveSonnetFn(opts.sonnetFn);
  const recordingSonnet: SonnetFn = async (input) => {
    const resp = await baseSonnet(input);
    try {
      budget.record(resp.modelId, resp.usage);
    } catch (e) {
      if (e instanceof BudgetExhausted) budgetHit = true;
      else throw e;
    }
    return resp;
  };

  const syntheses: DeepSynthItem[] = [];
  let questionsAsked = 0;
  let budgetExhausted = false;

  for (const question of questions) {
    // Pre-flight: don't dispatch a paid think when the worst-case cost would
    // breach the shared cap (also stops unpriced models — wouldExceed → true).
    if (budget.wouldExceed(modelId, estimateUsage(question))) {
      budgetExhausted = true;
      break;
    }
    questionsAsked += 1;
    const res = await runThink(storage, {
      question,
      sonnetFn: recordingSonnet,
      modelId,
      ...(opts.k !== undefined ? { k: opts.k } : {}),
      ...(opts.pagesFn ? { pagesFn: opts.pagesFn } : {}),
    });
    if (res.synthesis) {
      syntheses.push({
        question,
        synthesis: res.synthesis,
        pagesGathered: res.pagesGathered,
        takesGathered: res.takesGathered,
      });
    }
    // The wrapper tipped the shared ceiling on this question — its synthesis is
    // kept (already paid for); stop before spending on the next one.
    if (budgetHit) {
      budgetExhausted = true;
      break;
    }
  }

  return {
    ran: true,
    questionsAsked,
    syntheses,
    spentUsd: Number(budget.totalSpent().toFixed(6)),
    budgetExhausted,
  };
}

function blank(reason: string): DeepSynthResult {
  return {
    ran: false,
    reason,
    questionsAsked: 0,
    syntheses: [],
    spentUsd: 0,
    budgetExhausted: false,
  };
}
