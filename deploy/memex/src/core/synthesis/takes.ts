/**
 * Takes synthesis phases — written ONLY to `synth_takes` / `synth_take_grades`.
 *
 *   propose_takes — scan corpus documents, extract opinionated gradeable claims
 *     ("takes": a prediction/judgment/bet that could turn out wrong), queue them.
 *   grade_takes   — evidence-ground each queued take into a confidence verdict.
 *
 * Architecture guard: both read the authored vault (documents/chunks) but write
 * exclusively to the synth_* namespace. propose_takes only QUEUES (status
 * 'queued'); nothing here ever mutates a note or auto-applies a verdict.
 *
 * Safety: opt-in; budget-capped (`maxDocs` / `maxTakes`); idempotent
 * (take_key UNIQUE; grade keyed on (take_id, prompt_version, evidence_sig));
 * fail-open (per-item LLM error logs + skips).
 *
 * LLM injected via `opts.llmFn`. NO live Bedrock in tests.
 */
import { createHash } from "node:crypto";
import type { Engine } from "../engine/interface.ts";
import { resolveLlmFn, type LlmFn } from "../llm/nova.ts";
import { contentHash16 } from "./atoms.ts";

export const PROPOSE_TAKES_PROMPT_VERSION = "v1-nova";
export const GRADE_TAKES_PROMPT_VERSION = "v1-nova";

const DEFAULT_MAX_DOCS = 25;
const DEFAULT_MAX_TAKES = 25;
const MIN_DOC_CHARS = 400;
const MAX_DOC_CHARS_TO_LLM = 50_000;

export const TAKE_KINDS = ["prediction", "judgment", "bet"] as const;
export type TakeKind = (typeof TAKE_KINDS)[number];

export const TAKE_VERDICTS = ["correct", "incorrect", "partial", "unresolvable"] as const;
export type TakeVerdict = (typeof TAKE_VERDICTS)[number];

// --- propose_takes ----------------------------------------------------------

export interface ProposeTakesOptions {
  maxDocs?: number;
  llmFn?: LlmFn;
  modelId?: string;
  promptVersion?: string;
}

export interface ProposeTakesResult {
  documentsScanned: number;
  documentsProcessed: number;
  takesQueued: number;
  errors: string[];
}

interface ParsedTake {
  claim_text: string;
  kind: TakeKind;
  weight: number;
  domain?: string;
}

interface SourceDoc {
  id: string;
  text: string;
  contentHash16: string;
}

const PROPOSE_SYSTEM_PROMPT = `Extract gradeable claims from the note below.

A "gradeable claim" is a prediction, recommendation, or interpretive judgment
that could turn out wrong over time. NOT gradeable: pure facts, direct quotes
without endorsement, restatements.

For each claim output an object:
  {"claim_text": (<=200 chars), "kind": ("prediction"|"judgment"|"bet"),
   "weight": (0..1 from hedging language: "I bet"=0.7-0.85, "I think"=0.5-0.7,
   "maybe"=0.3-0.5), "domain": (short tag, e.g. "tactics","macro","hiring")}

Output ONLY a JSON array. No prose. If no gradeable claims, return [].`;

export function takeKey(
  sourceRef: string,
  sourceHash16: string,
  promptVersion: string,
  claim: string,
): string {
  return createHash("sha256")
    .update(`${sourceRef} ${sourceHash16} ${promptVersion} ${claim}`)
    .digest("hex");
}

/** Parse the LLM proposal output. Tolerant; never throws. */
export function parseTakesResponse(raw: string): ParsedTake[] {
  let cleaned = raw.trim();
  const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence && fence[1] !== undefined) cleaned = fence[1].trim();
  const start = cleaned.indexOf("[");
  if (start === -1) return [];
  cleaned = cleaned.slice(start);
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const end = cleaned.lastIndexOf("]");
    if (end === -1) return [];
    try {
      parsed = JSON.parse(cleaned.slice(0, end + 1));
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  const out: ParsedTake[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const o = item as Record<string, unknown>;
    const claim = typeof o.claim_text === "string" ? o.claim_text.trim() : "";
    if (!claim || claim.length > 500) continue;
    const rawKind = typeof o.kind === "string" ? o.kind : "";
    const kind: TakeKind = (TAKE_KINDS as readonly string[]).includes(rawKind)
      ? (rawKind as TakeKind)
      : "judgment";
    const wRaw = typeof o.weight === "number" ? o.weight : 0.5;
    const weight = Math.max(0, Math.min(1, Number.isFinite(wRaw) ? wRaw : 0.5));
    const domain =
      typeof o.domain === "string" && o.domain.trim().length > 0
        ? o.domain.trim().slice(0, 100)
        : undefined;
    const t: ParsedTake = { claim_text: claim, kind, weight };
    if (domain !== undefined) t.domain = domain;
    out.push(t);
  }
  return out;
}

async function discoverTakeDocuments(engine: Engine, maxDocs: number): Promise<SourceDoc[]> {
  const { rows } = await engine.query<{ id: string; text: string }>(
    `SELECT d.id,
            string_agg(c.content, E'\n\n' ORDER BY c.chunk_index) AS text
       FROM documents d
       JOIN chunks c ON c.document_id = d.id
      WHERE d.deleted_at IS NULL
      GROUP BY d.id
      ORDER BY d.updated_at DESC`,
  );
  const candidates: SourceDoc[] = [];
  for (const r of rows) {
    const text = r.text ?? "";
    if (text.length < MIN_DOC_CHARS) continue;
    candidates.push({ id: r.id, text, contentHash16: contentHash16(text) });
  }
  if (candidates.length === 0) return [];

  // Pair via unnest (tuple match, not the cross-product of two ANY() arrays).
  const refs = candidates.map((c) => c.id);
  const hashes = candidates.map((c) => c.contentHash16);
  const { rows: existing } = await engine.query<{ source_ref: string; source_hash: string }>(
    `SELECT DISTINCT t.source_ref, t.source_hash
       FROM synth_takes t
       JOIN unnest($1::text[], $2::text[]) AS w(source_ref, source_hash)
         ON t.source_ref = w.source_ref AND t.source_hash = w.source_hash`,
    [refs, hashes],
  );
  const done = new Set(existing.map((e) => `${e.source_ref} ${e.source_hash}`));
  return candidates.filter((c) => !done.has(`${c.id} ${c.contentHash16}`)).slice(0, maxDocs);
}

export async function proposeTakesPhase(
  engine: Engine,
  opts: ProposeTakesOptions = {},
): Promise<ProposeTakesResult> {
  const maxDocs = opts.maxDocs ?? DEFAULT_MAX_DOCS;
  const promptVersion = opts.promptVersion ?? PROPOSE_TAKES_PROMPT_VERSION;
  const llm = resolveLlmFn(opts.llmFn, opts.modelId ? { modelId: opts.modelId } : {});
  const result: ProposeTakesResult = {
    documentsScanned: 0,
    documentsProcessed: 0,
    takesQueued: 0,
    errors: [],
  };

  const docs = await discoverTakeDocuments(engine, maxDocs);
  result.documentsScanned = docs.length;

  for (const doc of docs) {
    let text: string;
    let modelId: string;
    try {
      const resp = await llm({
        system: PROPOSE_SYSTEM_PROMPT,
        user: `Source: ${doc.id}\n\n---\n\n${doc.text.slice(0, MAX_DOC_CHARS_TO_LLM)}`,
        maxTokens: 1200,
      });
      text = resp.text;
      modelId = resp.modelId;
    } catch (e) {
      result.errors.push(`${doc.id}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }

    const takes = parseTakesResponse(text);
    result.documentsProcessed += 1;
    for (const take of takes) {
      const key = takeKey(doc.id, doc.contentHash16, promptVersion, take.claim_text);
      try {
        await engine.query(
          `INSERT INTO synth_takes
             (take_key, source_ref, source_hash, prompt_version, claim_text, kind, weight, domain, status, model_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'queued', $9)
           ON CONFLICT (take_key) DO NOTHING`,
          [key, doc.id, doc.contentHash16, promptVersion, take.claim_text, take.kind, take.weight, take.domain ?? null, modelId],
        );
        result.takesQueued += 1;
      } catch (e) {
        result.errors.push(`${doc.id} take write: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  return result;
}

// --- grade_takes ------------------------------------------------------------

export interface GradeTakesOptions {
  maxTakes?: number;
  llmFn?: LlmFn;
  modelId?: string;
  promptVersion?: string;
  /** Inject evidence retrieval (tests). Default: hybrid-search over the corpus. */
  evidenceFn?: (claim: string) => Promise<string>;
}

export interface GradeTakesResult {
  takesScanned: number;
  gradesWritten: number;
  cacheHits: number;
  errors: string[];
}

interface ParsedVerdict {
  verdict: TakeVerdict;
  confidence: number;
  reasoning: string;
}

const GRADE_SYSTEM_PROMPT = `You are grading a single forecasting take against
evidence. Decide whether the claim turned out:
- correct      (the world matches the claim)
- incorrect    (the world clearly contradicts it)
- partial      (some right, some wrong)
- unresolvable (insufficient evidence; outcome still pending)

Output ONLY one JSON object:
  {"verdict": ("correct"|"incorrect"|"partial"|"unresolvable"),
   "confidence": (0..1), "reasoning": (<=400 chars)}

If evidence is sparse, return verdict="unresolvable" with low confidence.`;

export function evidenceSignature(evidence: string, modelId: string): string {
  return createHash("sha256").update(`${modelId}|${evidence}`).digest("hex");
}

/** Parse a single-object verdict. Tolerant; returns null on failure. */
export function parseVerdictResponse(raw: string): ParsedVerdict | null {
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
  const rawV = typeof o.verdict === "string" ? o.verdict : "";
  if (!(TAKE_VERDICTS as readonly string[]).includes(rawV)) return null;
  const cRaw = typeof o.confidence === "number" ? o.confidence : Number.parseFloat(String(o.confidence ?? ""));
  if (!Number.isFinite(cRaw)) return null;
  const confidence = Math.max(0, Math.min(1, cRaw));
  const reasoning = typeof o.reasoning === "string" ? o.reasoning.slice(0, 400) : "";
  return { verdict: rawV as TakeVerdict, confidence, reasoning };
}

/**
 * Default evidence retriever — pulls the top corpus chunks matching the claim
 * via a keyword scan (deterministic, no LLM, no Bedrock). Production callers can
 * inject a richer hybrid retriever; the default keeps grade_takes self-contained
 * and offline-testable. Fail-soft: returns a claim-only stub on query error.
 */
async function defaultEvidence(engine: Engine, claim: string): Promise<string> {
  try {
    // Escape LIKE wildcards so a `%`/`_` in the (LLM-derived) claim can't turn
    // the predicate into a match-everything scan.
    const needle = claim.slice(0, 60).replace(/[\\%_]/g, "\\$&");
    const { rows } = await engine.query<{ content: string }>(
      `SELECT content FROM chunks
        WHERE content ILIKE '%' || $1 || '%' ESCAPE '\\'
        ORDER BY length(content) ASC
        LIMIT 5`,
      [needle],
    );
    if (rows.length === 0) return `No corpus evidence found for claim: ${claim}`;
    return rows.map((r, i) => `[${i + 1}] ${r.content.slice(0, 800)}`).join("\n\n");
  } catch {
    return `Evidence retrieval failed; claim only: ${claim}`;
  }
}

export async function gradeTakesPhase(
  engine: Engine,
  opts: GradeTakesOptions = {},
): Promise<GradeTakesResult> {
  const maxTakes = opts.maxTakes ?? DEFAULT_MAX_TAKES;
  const promptVersion = opts.promptVersion ?? GRADE_TAKES_PROMPT_VERSION;
  const llm = resolveLlmFn(opts.llmFn, opts.modelId ? { modelId: opts.modelId } : {});
  const evidenceFn = opts.evidenceFn ?? ((claim: string) => defaultEvidence(engine, claim));
  const result: GradeTakesResult = {
    takesScanned: 0,
    gradesWritten: 0,
    cacheHits: 0,
    errors: [],
  };

  // Queued takes that have no grade yet for this prompt version, oldest first.
  const { rows: takes } = await engine.query<{ id: number; claim_text: string }>(
    `SELECT t.id, t.claim_text
       FROM synth_takes t
      WHERE t.status = 'queued'
        AND NOT EXISTS (
          SELECT 1 FROM synth_take_grades g
           WHERE g.take_id = t.id AND g.prompt_version = $1
        )
      ORDER BY t.id ASC
      LIMIT $2`,
    [promptVersion, maxTakes],
  );

  for (const take of takes) {
    result.takesScanned += 1;
    let evidence: string;
    try {
      evidence = await evidenceFn(take.claim_text);
    } catch (e) {
      result.errors.push(`take ${take.id} evidence: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }

    let verdict: ParsedVerdict | null;
    let modelId: string;
    try {
      const resp = await llm({
        system: GRADE_SYSTEM_PROMPT,
        user: `Claim: ${take.claim_text}\n\nEvidence:\n${evidence}`,
        maxTokens: 500,
      });
      verdict = parseVerdictResponse(resp.text);
      modelId = resp.modelId;
    } catch (e) {
      result.errors.push(`take ${take.id} judge: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    // A parse failure becomes a low-confidence unresolvable row so the operator
    // sees the failure rather than the take silently disappearing.
    const v: ParsedVerdict = verdict ?? {
      verdict: "unresolvable",
      confidence: 0,
      reasoning: "judge_output_parse_failed",
    };

    const sig = evidenceSignature(evidence, modelId);
    try {
      const { rows: written } = await engine.query<{ id: number }>(
        `INSERT INTO synth_take_grades
           (take_id, prompt_version, evidence_signature, verdict, confidence, reasoning, model_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (take_id, prompt_version, evidence_signature) DO NOTHING
         RETURNING id`,
        [take.id, promptVersion, sig, v.verdict, v.confidence, v.reasoning, modelId],
      );
      if (written.length > 0) result.gradesWritten += 1;
      else result.cacheHits += 1;
    } catch (e) {
      result.errors.push(`take ${take.id} grade write: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return result;
}
