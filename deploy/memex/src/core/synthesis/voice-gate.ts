/**
 * Voice gate — one function, multiple calibration UX surfaces. A single gate:
 * mode-specific tuning lives in the rubric the gate ships to its Haiku judge,
 * never in forked gate implementations.
 *
 * A surface that wants to show LLM-generated voice to the user runs its
 * candidate through the gate: a small Haiku judge classifies it as
 * conversational (friend talking to friend) or academic (clinical/corporate).
 * Reject → regenerate with the judge's reason as feedback, up to 2 attempts,
 * then fall back to the caller's deterministic template. The outcome
 * (passed + attempts) is returned for audit — failing silently is never an
 * option; the calibration phase records it on the profile row.
 *
 * The judge is the injectable `LlmFn` seam (production: Claude Haiku via
 * Bedrock; tests: a stub). No new spend class: the gate only runs inside
 * phases that already hold the utility-LLM seam.
 */
import type { LlmFn } from "../llm/haiku.ts";
import { sanitizeForPrompt } from "../llm/sanitize.ts";

export type VoiceGateMode = "pattern_statement" | "nudge";

export interface VoiceGateJudgeVerdict {
  verdict: "conversational" | "academic";
  reason: string;
}

export interface VoiceGateResult {
  /** The final text — an accepted generation, or the template fallback. */
  text: string;
  /** Did a generation attempt pass the rubric? */
  passed: boolean;
  /** Generation attempts consumed before pass/fallback. */
  attempts: number;
  /** Reason from the LAST judge call. */
  lastReason?: string;
}

/** Produces ONE candidate per call; `feedback` carries the last reject reason. */
export type VoiceGateGenerator = (input: {
  attempt: number;
  feedback?: string;
}) => Promise<string>;

export interface VoiceGateOpts {
  mode: VoiceGateMode;
  generate: VoiceGateGenerator;
  /** Deterministic fallback used when every attempt fails. */
  templateFallback: () => string;
  /** The Haiku judge seam. */
  llmFn: LlmFn;
  /** Max generation attempts before falling back. Default 2. */
  maxAttempts?: number;
  /** Override the per-mode rubric (rarely needed). */
  rubric?: string;
}

export const DEFAULT_RUBRICS: Record<VoiceGateMode, string> = {
  pattern_statement: `Voice for a calibration pattern statement:
- Sounds like a smart friend recapping your record, not a doctor or HR.
- Uses second person ("your", "you") or plain direct phrasing.
- Names numbers grounded in actual takes ("2 of 3 missed"), not abstract
  metrics like "Brier 0.31".
- No preachy/clinical phrasing ("our analysis indicates", "the data shows").
- Short — under 25 words per statement.`,

  nudge: `Voice for a real-time nudge fired when a take is committed:
- Sounds like a friend tapping you on the shoulder, not an alert system.
- Second person, contractions allowed, casual.
- Grounded in 1-2 concrete past data points.
- Under 30 words. NEVER preachy, NEVER "we recommend".`,
};

const DEFAULT_MAX_ATTEMPTS = 2;

const JUDGE_SYSTEM_PROMPT = `You are the voice gate for a personal AI brain. A surface wants to show
the candidate text to the user. Decide whether it sounds conversational
(friend talking to friend) or academic (clinical / corporate).

Output ONLY a JSON object: {"verdict":"conversational"|"academic","reason":"<max 80 chars>"}.`;

/**
 * Parse the judge's JSON. On unrecoverable parse failure the candidate is
 * treated as 'academic' (reason=parse_failed) so the gate falls back to the
 * template rather than silently passing bad voice.
 */
export function parseVoiceJudgeOutput(raw: string): VoiceGateJudgeVerdict {
  if (!raw || raw.trim().length === 0) {
    return { verdict: "academic", reason: "empty_judge_output" };
  }
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence && fence[1] !== undefined) text = fence[1].trim();
  const start = text.indexOf("{");
  if (start === -1) return { verdict: "academic", reason: "parse_failed" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start));
  } catch {
    const end = text.lastIndexOf("}");
    if (end === -1) return { verdict: "academic", reason: "parse_failed" };
    try {
      parsed = JSON.parse(text.slice(start, end + 1));
    } catch {
      return { verdict: "academic", reason: "parse_failed" };
    }
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { verdict: "academic", reason: "parse_failed" };
  }
  const o = parsed as Record<string, unknown>;
  const verdict = o.verdict === "conversational" ? "conversational" : "academic";
  const reason = typeof o.reason === "string" ? o.reason.slice(0, 80) : "no_reason";
  return { verdict, reason };
}

async function judgeCandidate(
  llm: LlmFn,
  candidate: string,
  rubric: string,
): Promise<VoiceGateJudgeVerdict> {
  const resp = await llm({
    system: JUDGE_SYSTEM_PROMPT,
    user: `RUBRIC for this surface:\n${rubric}\n\nCANDIDATE:\n${sanitizeForPrompt(candidate).text}`,
    maxTokens: 100,
  });
  return parseVoiceJudgeOutput(resp.text);
}

/**
 * Gate one piece of LLM-generated voice. Never throws: a generator or judge
 * error counts as a failed attempt; exhausting attempts falls back to the
 * template with passed=false.
 */
export async function gateVoice(opts: VoiceGateOpts): Promise<VoiceGateResult> {
  const rubric = opts.rubric ?? DEFAULT_RUBRICS[opts.mode];
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  let lastReason: string | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let candidate: string;
    try {
      candidate = await opts.generate({
        attempt,
        ...(lastReason !== undefined ? { feedback: lastReason } : {}),
      });
    } catch (err) {
      lastReason = err instanceof Error ? err.message : "generator_threw";
      continue;
    }
    if (!candidate || candidate.trim().length === 0) {
      lastReason = "empty_generation";
      continue;
    }
    let verdict: VoiceGateJudgeVerdict;
    try {
      verdict = await judgeCandidate(opts.llmFn, candidate, rubric);
    } catch (err) {
      lastReason = err instanceof Error ? err.message : "judge_threw";
      continue;
    }
    if (verdict.verdict === "conversational") {
      return { text: candidate, passed: true, attempts: attempt, lastReason: verdict.reason };
    }
    lastReason = verdict.reason;
  }

  return {
    text: opts.templateFallback(),
    passed: false,
    attempts: maxAttempts,
    ...(lastReason !== undefined ? { lastReason } : {}),
  };
}
