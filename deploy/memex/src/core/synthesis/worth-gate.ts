/**
 * Worth gate — cached Haiku significance verdicts in front of the paid Sonnet
 * transcript consumers (conversation-facts backfill, reflections). Judge "is
 * this transcript worth synthesizing?" with the cheap utility model, cache the
 * verdict per (source_ref, content_hash) in synth_worth_verdicts (migration
 * 077), and only
 * let worthwhile transcripts through to the Sonnet spend. The cache sits
 * BEFORE the spend: a re-run never re-pays the judge for unchanged content.
 *
 * Default-OFF (MEMEX_WORTH_GATE=1): with the gate off, callers behave exactly
 * as before (everything passes). The gate itself is fail-open — a judge error
 * keeps the transcript (the gate exists to save money, and a broken gate must
 * never silently starve the pipeline).
 */
import { createHash } from "node:crypto";
import type { Engine } from "../engine/interface.ts";
import { resolveLlmFn, type LlmFn } from "../llm/haiku.ts";
import { sanitizeForPrompt } from "../llm/sanitize.ts";

export function worthGateEnabled(
  raw: string | undefined = process.env.MEMEX_WORTH_GATE,
): boolean {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
}

/** 16-char content hash — matches the synth layer's source-change signal. */
export function worthContentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export interface WorthVerdict {
  worth_processing: boolean;
  reasons: string[];
}

const JUDGE_SYSTEM_PROMPT = `You judge whether a transcript is worth synthesizing into a personal
knowledge brain.

WORTH PROCESSING (worth_processing=true):
- A new idea, frame, mental model, or thesis is articulated
- Self-reflection, named patterns, processed emotion
- Specific people, companies, or decisions discussed in depth
- A strategic call worth remembering

NOT WORTH PROCESSING (worth_processing=false):
- Routine ops ("check my email", "schedule X")
- Pure code debugging without reflection
- Short exchanges with no original thought
- Repetitive content the brain already has

Respond as JSON: {"worth_processing": <bool>, "reasons": ["<short>", "<short>"]}.
Two reasons max, one phrase each.`;

/** Head + tail excerpt for the judge — significance shows at the edges. */
function excerptForJudge(content: string): string {
  if (content.length <= 8000) return content;
  return `${content.slice(0, 4000)}\n[...truncated...]\n${content.slice(content.length - 4000)}`;
}

/** Parse the judge JSON. Null on failure (caller treats as fail-open keep). */
export function parseWorthVerdict(raw: string): WorthVerdict | null {
  // First `{` to last `}` by index, not by regex. `/\{[\s\S]*\}/` means exactly
  // that — leftmost `{`, then greedy to the last `}` — but it pays for it: when
  // there is no closing brace the body walks to the end of the judge's answer
  // from every `{`, and the answer is model output we do not write. Measured
  // through parseWorthVerdict on "{"*n: 2 K = 1.5 ms, 4 K = 5.8 ms,
  // 8 K = 26.4 ms, 16 K = 92.8 ms — ratio ~4.0 per doubling. The index form is
  // one forward scan and one backward scan, and `parseAtomsResponse` already
  // uses this idiom for the array case.
  const text = raw ?? "";
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    if (typeof parsed.worth_processing !== "boolean") return null;
    const reasons = Array.isArray(parsed.reasons)
      ? parsed.reasons.filter((r): r is string => typeof r === "string").slice(0, 4)
      : [];
    return { worth_processing: parsed.worth_processing, reasons };
  } catch {
    return null;
  }
}

export async function getCachedWorthVerdict(
  engine: Engine,
  sourceRef: string,
  contentHash: string,
): Promise<WorthVerdict | null> {
  try {
    const { rows } = await engine.query<{ worth_processing: boolean; reasons: unknown }>(
      `SELECT worth_processing, reasons FROM synth_worth_verdicts
        WHERE source_ref = $1 AND content_hash = $2`,
      [sourceRef, contentHash],
    );
    const row = rows[0];
    if (!row) return null;
    let reasons: unknown = row.reasons;
    if (typeof reasons === "string") {
      try {
        reasons = JSON.parse(reasons);
      } catch {
        reasons = [];
      }
    }
    return {
      worth_processing: row.worth_processing,
      reasons: Array.isArray(reasons)
        ? reasons.filter((r): r is string => typeof r === "string")
        : [],
    };
  } catch {
    return null;
  }
}

export async function putWorthVerdict(
  engine: Engine,
  sourceRef: string,
  contentHash: string,
  verdict: WorthVerdict,
  modelId: string,
): Promise<void> {
  try {
    await engine.query(
      `INSERT INTO synth_worth_verdicts
         (source_ref, content_hash, worth_processing, reasons, model_id)
       VALUES ($1, $2, $3, $4::text::jsonb, $5)
       ON CONFLICT (source_ref, content_hash) DO NOTHING`,
      [sourceRef, contentHash, verdict.worth_processing, JSON.stringify(verdict.reasons), modelId],
    );
  } catch {
    /* cache write is best-effort */
  }
}

export interface WorthGateItem {
  /** Page slug (or other stable ref) the verdict is cached under. */
  ref: string;
  /** The transcript body the verdict judges. */
  content: string;
}

export interface WorthGateOutcome {
  /** refs that passed (worth processing, cache-hit or fresh). */
  kept: Set<string>;
  judged: number;
  cacheHits: number;
  skipped: number;
  errors: string[];
}

/**
 * Filter transcripts through the cached worth gate. Fail-open per item: a
 * judge/parse error keeps the item and records the error. The judge runs on
 * the injectable Haiku seam (`llmFn`) — hermetic in tests.
 */
export async function filterWorthwhile(
  engine: Engine,
  items: readonly WorthGateItem[],
  opts: { llmFn?: LlmFn; modelId?: string } = {},
): Promise<WorthGateOutcome> {
  const llm = resolveLlmFn(opts.llmFn, opts.modelId ? { modelId: opts.modelId } : {});
  const out: WorthGateOutcome = {
    kept: new Set<string>(),
    judged: 0,
    cacheHits: 0,
    skipped: 0,
    errors: [],
  };
  for (const item of items) {
    const hash = worthContentHash(item.content);
    const cached = await getCachedWorthVerdict(engine, item.ref, hash);
    if (cached) {
      out.cacheHits += 1;
      if (cached.worth_processing) out.kept.add(item.ref);
      else out.skipped += 1;
      continue;
    }
    let verdict: WorthVerdict | null = null;
    let modelId = "unknown";
    try {
      const resp = await llm({
        system: JUDGE_SYSTEM_PROMPT,
        user: `Transcript ${item.ref}:\n\n${sanitizeForPrompt(excerptForJudge(item.content)).text}`,
        maxTokens: 200,
      });
      modelId = resp.modelId;
      verdict = parseWorthVerdict(resp.text);
      out.judged += 1;
    } catch (e) {
      out.errors.push(`${item.ref}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!verdict) {
      // Fail-open: an unjudgeable transcript passes (old behaviour) and is NOT
      // cached, so a healthy later run can still judge it.
      out.kept.add(item.ref);
      continue;
    }
    await putWorthVerdict(engine, item.ref, hash, verdict, modelId);
    if (verdict.worth_processing) out.kept.add(item.ref);
    else out.skipped += 1;
  }
  return out;
}
