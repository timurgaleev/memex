/**
 * synthesize_concepts synthesis phase — global clustering of atoms into concept
 * pages, written ONLY to `synth_concepts` (+ the `synth_concept_atoms`
 * provenance link). Reads `synth_atoms`; never touches authored notes.
 *
 * Algorithm (faithful to the reference, adapted to memex tables):
 *   1. Read all atoms with concept tags from `synth_atoms`.
 *   2. Group by concept tag.
 *   3. Filter to groups with >= 2 atoms; tier by count (T1 >=10, T2 >=5, T3 >=2).
 *   4. T1/T2: Claude Haiku synthesizes a 1-paragraph narrative. T3: deterministic stub.
 *   5. Upsert one `synth_concepts` row per group + provenance links.
 *
 * Safety: opt-in; budget-capped via `maxConcepts` (cost guard on LLM calls);
 * idempotent (concept_slug UNIQUE → upsert; provenance links re-inserted with
 * ON CONFLICT DO NOTHING); fail-open (an LLM error falls back to the
 * deterministic narrative, never aborts).
 */
import type { Engine } from "../engine/interface.ts";
import type { Storage } from "../storage.ts";
import { putPage } from "../pages.ts";
import { resolveLlmFn, type LlmFn } from "../llm/haiku.ts";
import { synthPagesEnabled, slugifyTitle } from "./atoms.ts";

const DEFAULT_MAX_CONCEPTS = 30;
const TIER_T1_MIN = 10;
const TIER_T2_MIN = 5;
const TIER_T3_MIN = 2;

export type ConceptTier = "T1" | "T2" | "T3";

export interface SynthesizeConceptsOptions {
  /** Max concept groups to LLM-synthesize this run (cost guard). Default 30. */
  maxConcepts?: number;
  llmFn?: LlmFn;
  modelId?: string;
  /**
   * Storage handle for the concept page mirror (`concepts/<slug>` via putPage)
   * so concept narratives are retrievable through normal search. Absent →
   * rows only. Gated globally by MEMEX_SYNTH_PAGES (default ON).
   */
  storage?: Storage;
}

export interface SynthesizeConceptsResult {
  atomsSeen: number;
  groupsFound: number;
  conceptsWritten: number;
  /** Concept pages written via putPage (0 when no storage / gated off). */
  pagesWritten: number;
  tierCounts: Record<ConceptTier, number>;
  errors: string[];
}

interface AtomRow {
  id: number;
  title: string;
  body: string;
  concepts: unknown;
}

interface ConceptGroup {
  slug: string;
  tier: ConceptTier;
  atomIds: number[];
  titles: string[];
  bodies: string[];
}

const SYSTEM_PROMPT = `You write a 1-paragraph executive summary of a concept,
based on multiple atomic insights that reference it.

Output ONLY the summary paragraph (3-5 sentences). No headers, no JSON, no
preamble. Synthesize what the atoms collectively SAY about the concept; do not
enumerate them.`;

function tierFor(count: number): ConceptTier {
  if (count >= TIER_T1_MIN) return "T1";
  if (count >= TIER_T2_MIN) return "T2";
  return "T3";
}

/** Normalize a stored `concepts` JSONB into a clean string[]. Never throws. */
function parseConcepts(raw: unknown): string[] {
  let v = raw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(v)) return [];
  return v
    .filter((c): c is string => typeof c === "string" && c.trim().length > 0)
    .map((c) => c.trim().toLowerCase());
}

/** Deterministic narrative for T3 groups (and LLM-failure fallback). */
export function deterministicNarrative(group: ConceptGroup): string {
  const n = group.titles.length;
  const top = group.titles.slice(0, 5).map((t) => `- ${t}`).join("\n");
  return `${group.tier} concept. ${n} atom${n === 1 ? "" : "s"} reference this.\nTop mentions:\n${top}`;
}

export async function synthesizeConceptsPhase(
  engine: Engine,
  opts: SynthesizeConceptsOptions = {},
): Promise<SynthesizeConceptsResult> {
  const maxConcepts = opts.maxConcepts ?? DEFAULT_MAX_CONCEPTS;
  const llm = resolveLlmFn(opts.llmFn, opts.modelId ? { modelId: opts.modelId } : {});
  const writePages = opts.storage !== undefined && synthPagesEnabled();
  const result: SynthesizeConceptsResult = {
    atomsSeen: 0,
    groupsFound: 0,
    conceptsWritten: 0,
    pagesWritten: 0,
    tierCounts: { T1: 0, T2: 0, T3: 0 },
    errors: [],
  };

  const { rows } = await engine.query<AtomRow>(
    `SELECT id, title, body, concepts FROM synth_atoms`,
  );
  result.atomsSeen = rows.length;
  if (rows.length === 0) return result;

  const groups = new Map<string, { atomIds: number[]; titles: string[]; bodies: string[] }>();
  for (const r of rows) {
    for (const slug of parseConcepts(r.concepts)) {
      const g = groups.get(slug) ?? { atomIds: [], titles: [], bodies: [] };
      g.atomIds.push(Number(r.id));
      g.titles.push(r.title);
      g.bodies.push(r.body);
      groups.set(slug, g);
    }
  }

  const eligible: ConceptGroup[] = [];
  for (const [slug, g] of groups) {
    if (g.titles.length < TIER_T3_MIN) continue;
    eligible.push({ slug, tier: tierFor(g.titles.length), ...g });
  }
  result.groupsFound = eligible.length;

  // Deterministic ordering: larger groups first (most-referenced concepts get
  // the LLM budget), then alphabetical for a stable tie-break.
  eligible.sort((a, b) =>
    b.titles.length - a.titles.length || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0),
  );

  let llmCalls = 0;
  for (const group of eligible) {
    let narrative = deterministicNarrative(group);
    let modelId = opts.modelId ?? "deterministic";
    const wantLlm = group.tier === "T1" || group.tier === "T2";
    if (wantLlm && llmCalls < maxConcepts) {
      llmCalls += 1;
      try {
        const resp = await llm({
          system: SYSTEM_PROMPT,
          user:
            `Concept: ${group.slug}\n` +
            `${group.titles.length} atoms reference this.\n\n` +
            `Atom titles:\n${group.titles.slice(0, 10).map((t) => `- ${t}`).join("\n")}\n\n` +
            `Atom bodies:\n${group.bodies.slice(0, 5).map((b, i) => `${i + 1}. ${b.slice(0, 500)}`).join("\n\n")}`,
          maxTokens: 400,
        });
        const txt = resp.text.trim();
        if (txt.length > 0) {
          narrative = txt;
          modelId = resp.modelId;
        }
      } catch (e) {
        // Fail-open: keep the deterministic narrative.
        result.errors.push(`${group.slug}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    const title = (group.slug.split("/").pop() ?? group.slug).replace(/-/g, " ");
    try {
      await engine.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO synth_concepts (concept_slug, title, narrative, tier, atom_count, generated_at, model_id)
           VALUES ($1, $2, $3, $4, $5, now(), $6)
           ON CONFLICT (concept_slug) DO UPDATE SET
             title = EXCLUDED.title,
             narrative = EXCLUDED.narrative,
             tier = EXCLUDED.tier,
             atom_count = EXCLUDED.atom_count,
             generated_at = EXCLUDED.generated_at,
             model_id = EXCLUDED.model_id`,
          [group.slug, title, narrative, group.tier, group.titles.length, modelId],
        );
        for (const atomId of group.atomIds) {
          await tx.query(
            `INSERT INTO synth_concept_atoms (concept_slug, atom_id)
             VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [group.slug, atomId],
          );
        }
      });
      result.conceptsWritten += 1;
      result.tierCounts[group.tier] += 1;
    } catch (e) {
      result.errors.push(`${group.slug} write: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }

    // Page mirror — concepts become retrievable through normal search (the
    // cycle's mirror phase indexes pages). Idempotent putPage upsert; a page
    // failure never loses the synth_concepts row.
    if (writePages && opts.storage) {
      const pageSlug = `concepts/${slugifyTitle(group.slug)}`;
      const mentions = group.titles.slice(0, 10).map((t) => `- ${t}`).join("\n");
      try {
        await putPage(opts.storage, {
          slug: pageSlug,
          type: "concept",
          title,
          markdown_body: `${narrative}\n\n## Atoms (${group.titles.length})\n${mentions}\n`,
          written_by: "synthesize-concepts",
        });
        result.pagesWritten += 1;
      } catch (e) {
        result.errors.push(`${group.slug} page: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  return result;
}
