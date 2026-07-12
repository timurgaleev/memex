/**
 * think persistence — `think --save` / `--take` core. The CLI/MCP flags live
 * with their own surfaces; these are the functions they call:
 *
 *   persistThinkSynthesis  write the synthesis as a real `synthesis/<slug>`
 *                          page (putPage, idempotent) + one synthesis_evidence
 *                          row per validated citation (migration 075), so a
 *                          think answer stops evaporating with the process.
 *   saveThinkTake          queue the answer's headline claim as a synth_takes
 *                          row pinned to an anchor page, entering the normal
 *                          propose→grade→calibrate loop.
 *
 * Both refuse empty input and never throw for a per-row failure (warnings
 * carry the misses). No LLM calls — persistence is free.
 */
import type { Storage } from "../storage.ts";
import type { Engine } from "../engine/interface.ts";
import { putPage } from "../pages.ts";
import { contentHash16 } from "./atoms.ts";
import { takeKey } from "./takes.ts";
import type { ThinkResult } from "./think.ts";

/** Prompt-version marker for operator-committed think takes. */
export const THINK_TAKE_PROMPT_VERSION = "think-take-v1";

export interface PersistSynthesisResult {
  /** The saved page slug; "" when nothing was persisted. */
  slug: string;
  evidenceInserted: number;
  warnings: string[];
}

/** Deterministic synthesis page slug: synthesis/<question-slug>-<date>. */
export function synthesisSlugFor(question: string, date: Date = new Date()): string {
  const day = date.toISOString().slice(0, 10);
  const safe =
    question
      .toLowerCase()
      .replace(/[^a-z0-9\s]+/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, 60)
      .replace(/-+$/g, "") || "untitled";
  return `synthesis/${safe}-${day}`;
}

/**
 * Persist a think result as a synthesis page + citation evidence rows.
 * An empty/missing answer is never persisted (returns slug="" + warning).
 */
export async function persistThinkSynthesis(
  storage: Storage,
  opts: {
    question: string;
    result: ThinkResult;
    /** Owning tenant for the saved page. Default "default". */
    sourceId?: string;
  },
): Promise<PersistSynthesisResult> {
  const s = opts.result.synthesis;
  if (!s || s.answer.trim().length === 0) {
    return { slug: "", evidenceInserted: 0, warnings: ["SYNTHESIS_EMPTY_NOT_PERSISTED"] };
  }
  const warnings: string[] = [];
  const slug = synthesisSlugFor(opts.question);
  const body = [
    `# ${opts.question}`,
    "",
    s.answer,
    "",
    s.gaps.length > 0 ? `## Gaps\n\n${s.gaps.map((g) => `- ${g}`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  await putPage(storage, {
    slug,
    type: "synthesis",
    allowAdHocType: true,
    title: opts.question.slice(0, 200),
    markdown_body: body,
    source_id: opts.sourceId ?? "default",
    written_by: "think",
  });

  const engine = storage.engine();
  let inserted = 0;
  for (let i = 0; i < s.citations.length; i++) {
    const c = s.citations[i]!;
    try {
      const { rows } = await engine.query<{ id: number }>(
        `INSERT INTO synthesis_evidence (synthesis_slug, ref, kind, citation_index)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (synthesis_slug, kind, ref) DO NOTHING
         RETURNING id`,
        [slug, c.ref, c.kind, i],
      );
      if (rows.length > 0) inserted += 1;
    } catch (e) {
      warnings.push(`evidence ${c.kind}:${c.ref}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { slug, evidenceInserted: inserted, warnings };
}

export interface SaveThinkTakeResult {
  take_key: string;
  /** false = an identical take already existed (idempotent no-op). */
  inserted: boolean;
}

/**
 * Queue a take distilled from a think run, pinned to an anchor page slug.
 * Enters the synth_takes review queue as status 'queued' — it is graded and
 * calibrated like any proposed take, never auto-accepted.
 */
export async function saveThinkTake(
  engine: Engine,
  opts: {
    claim: string;
    /** The anchor/synthesis page slug the take is provenanced to. */
    anchorSlug: string;
    /** Conviction weight 0..1. Default 0.6. */
    weight?: number;
    domain?: string;
    /** Provenance model id (the think run's model). Default "operator". */
    modelId?: string;
  },
): Promise<SaveThinkTakeResult> {
  const claim = (opts.claim ?? "").trim();
  if (!claim) throw new Error("saveThinkTake: claim must be non-empty");
  if (!opts.anchorSlug || opts.anchorSlug.trim().length === 0) {
    throw new Error("saveThinkTake: anchorSlug must be non-empty");
  }
  const weight = Math.max(0, Math.min(1, opts.weight ?? 0.6));
  const sourceHash = contentHash16(claim);
  const key = takeKey(opts.anchorSlug, sourceHash, THINK_TAKE_PROMPT_VERSION, claim);
  const { rows } = await engine.query<{ id: number }>(
    `INSERT INTO synth_takes
       (take_key, source_ref, source_hash, prompt_version, claim_text, kind, weight, domain, status, model_id)
     VALUES ($1, $2, $3, $4, $5, 'judgment', $6, $7, 'queued', $8)
     ON CONFLICT (take_key) DO NOTHING
     RETURNING id`,
    [
      key,
      opts.anchorSlug,
      sourceHash,
      THINK_TAKE_PROMPT_VERSION,
      claim.slice(0, 500),
      weight,
      opts.domain ?? null,
      opts.modelId ?? "operator",
    ],
  );
  return { take_key: key, inserted: rows.length > 0 };
}
