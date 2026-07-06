/**
 * extract_atoms synthesis phase — per-source distillation of corpus documents
 * into atomic claims ("atoms"), written ONLY to `synth_atoms`.
 *
 * Architecture guard: this phase READS from `documents` + `chunks` (the
 * authored vault) and WRITES to `synth_atoms`, plus — matching the reference,
 * which stores every atom as a page — an `atoms/<date>/<slug>` page mirror per
 * atom (via putPage) so atoms are retrievable through normal search. The page
 * write needs a Storage handle and can be disabled with MEMEX_SYNTH_PAGES=0.
 * Source notes remain sacrosanct: documents/chunks are never touched.
 *
 * Safety properties:
 *   - opt-in: only runs when the cycle requests the "extract-atoms" phase.
 *   - budget-capped: at most `maxDocs` documents per run (cost guard).
 *   - idempotent: each atom keys on hash(source_ref + source_hash + body); an
 *     unchanged document re-runs to a no-op via ON CONFLICT DO NOTHING, and the
 *     per-doc discovery skips documents that already have an atom for the
 *     current content hash.
 *   - fail-open: an LLM error on one document logs + skips that document; the
 *     phase continues and never corrupts the brain.
 *
 * The LLM is injected via `opts.llmFn` (see core/llm/haiku.ts). Tests pass a
 * fake; production resolves `callHaiku`. NO live Bedrock in tests.
 *
 * Ported faithfully from the reference's extract-atoms phase, adapted to
 * memex's flat single-source vault (no source_id) and own-namespace tables.
 */
import { createHash } from "node:crypto";
import type { Engine } from "../engine/interface.ts";
import type { Storage } from "../storage.ts";
import { putPage } from "../pages.ts";
import { resolveLlmFn, type LlmFn } from "../llm/haiku.ts";
import { sanitizeForPrompt } from "../llm/sanitize.ts";

/** Allowed atom_type values. A returned type outside this set falls back. */
export const ATOM_TYPES = [
  "insight",
  "anecdote",
  "quote",
  "framework",
  "statistic",
  "strategy",
  "critique",
] as const;
export type AtomType = (typeof ATOM_TYPES)[number];

const DEFAULT_MAX_DOCS = 25;
const MIN_DOC_CHARS = 400;
const MAX_DOC_CHARS_TO_LLM = 50_000;

export interface ExtractAtomsOptions {
  /** Max documents to process this run (cost guard). Default 25. */
  maxDocs?: number;
  /** Injected LLM seam. Tests pass a fake; production resolves callHaiku. */
  llmFn?: LlmFn;
  /** Override the utility model id (config / tests). */
  modelId?: string;
  /**
   * Storage handle for the atom page mirror (`atoms/<date>/<slug>` via
   * putPage). Absent → rows only, no pages (pre-076 behaviour). Page writes
   * can also be disabled globally with MEMEX_SYNTH_PAGES=0.
   */
  storage?: Storage;
}

export interface ExtractAtomsResult {
  documentsScanned: number;
  documentsProcessed: number;
  atomsWritten: number;
  /** Atom pages written via putPage (0 when no storage / gated off). */
  pagesWritten: number;
  errors: string[];
}

interface ParsedAtom {
  title: string;
  atom_type: AtomType;
  body: string;
  concepts: string[];
  /** Verbatim source line the atom was distilled from (<=200 chars). */
  source_quote?: string;
  /** One-sentence takeaway. */
  lesson?: string;
}

interface SourceDoc {
  id: string;
  text: string;
  contentHash16: string;
  sourceId: string | null;
}

const SYSTEM_PROMPT = `You extract atomic knowledge nuggets from a note.

An atom is a single-source, self-contained idea. Each atom must:
- Stand alone (no "as discussed above").
- Have a clear point (not merely descriptive).
- Be specific (not a generic platitude).

Output a JSON array of 1-3 atoms (never more than 3). Each atom is an object:
  {"title": (<=80 chars), "atom_type": (one of: ${ATOM_TYPES.join(", ")}),
   "body": (2-4 sentences), "concepts": (array of 1-3 short lowercase topic tags),
   "source_quote": (verbatim quote from the note, <=200 chars),
   "lesson": (one sentence naming the takeaway)}

Output ONLY the JSON array. No prose, no markdown fences.`;

/** Page mirror gate — default ON; MEMEX_SYNTH_PAGES=0 turns synth page writes off. */
export function synthPagesEnabled(
  raw: string | undefined = process.env.MEMEX_SYNTH_PAGES,
): boolean {
  return (raw ?? "").trim() !== "0";
}

/** Kebab page-slug segment from a free-text title. */
export function slugifyTitle(title: string): string {
  const s = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/^-+|-+$/g, "");
  return s.length > 0 ? s : "atom";
}

/** Stable 16-char content hash of a document's text (source-change signal). */
export function contentHash16(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** Deterministic idempotency key for an atom. */
export function atomKey(sourceRef: string, sourceHash16: string, body: string): string {
  return createHash("sha256")
    .update(`${sourceRef} ${sourceHash16} ${body}`)
    .digest("hex");
}

/**
 * Parse the LLM JSON response into atoms. Tolerant of fence wrapping and
 * leading/trailing prose; rejects (returns []) on hard parse failure or
 * invalid shape. Never throws.
 */
export function parseAtomsResponse(raw: string): ParsedAtom[] {
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

  const out: ParsedAtom[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const o = item as Record<string, unknown>;
    const title = typeof o.title === "string" ? o.title.slice(0, 200).trim() : "";
    const body = typeof o.body === "string" ? o.body.trim() : "";
    if (!title || !body) continue;
    const rawType = typeof o.atom_type === "string" ? o.atom_type : "";
    const atom_type: AtomType = (ATOM_TYPES as readonly string[]).includes(rawType)
      ? (rawType as AtomType)
      : "insight";
    const concepts = Array.isArray(o.concepts)
      ? o.concepts
          .filter((c): c is string => typeof c === "string" && c.trim().length > 0)
          .map((c) => c.trim().toLowerCase())
          .slice(0, 5)
      : [];
    const source_quote =
      typeof o.source_quote === "string" && o.source_quote.trim().length > 0
        ? o.source_quote.trim().slice(0, 200)
        : undefined;
    const lesson =
      typeof o.lesson === "string" && o.lesson.trim().length > 0
        ? o.lesson.trim().slice(0, 300)
        : undefined;
    out.push({
      title,
      atom_type,
      body,
      concepts,
      ...(source_quote !== undefined ? { source_quote } : {}),
      ...(lesson !== undefined ? { lesson } : {}),
    });
    if (out.length >= 3) break;
  }
  return out;
}

/**
 * Discover documents that still need atom extraction: live documents with
 * enough body text whose current content hash has NO atom row yet. One SQL
 * round-trip; the NOT EXISTS subquery is the idempotency filter.
 *
 * memex stores body text in `chunks`, not on `documents`, so the per-document
 * text is the concatenation of its chunks (ordered). Soft-deleted documents
 * (migration 040 added `deleted_at`) are excluded.
 */
async function discoverDocuments(
  engine: Engine,
  maxDocs: number,
): Promise<SourceDoc[]> {
  const { rows } = await engine.query<{ id: string; text: string; source_id: string | null }>(
    `SELECT d.id, d.source_id,
            string_agg(c.content, E'\n\n' ORDER BY c.chunk_index) AS text
       FROM documents d
       JOIN chunks c ON c.document_id = d.id
      WHERE d.deleted_at IS NULL
      GROUP BY d.id, d.source_id
      ORDER BY MAX(d.updated_at) DESC`,
  );

  const candidates: SourceDoc[] = [];
  for (const r of rows) {
    const text = r.text ?? "";
    if (text.length < MIN_DOC_CHARS) continue;
    candidates.push({ id: r.id, text, contentHash16: contentHash16(text), sourceId: r.source_id });
  }
  if (candidates.length === 0) return [];

  // Batch idempotency: which (source_ref, source_hash) PAIRS already have atoms.
  // Pair via unnest so the match is on the tuple, not the cross-product of the
  // two ANY() arrays (a doc whose hash coincides with another doc's hash must
  // NOT be falsely marked done).
  const refs = candidates.map((c) => c.id);
  const hashes = candidates.map((c) => c.contentHash16);
  const { rows: existing } = await engine.query<{ source_ref: string; source_hash: string }>(
    `SELECT DISTINCT a.source_ref, a.source_hash
       FROM synth_atoms a
       JOIN unnest($1::text[], $2::text[]) AS w(source_ref, source_hash)
         ON a.source_ref = w.source_ref AND a.source_hash = w.source_hash
      WHERE a.source_kind = 'document'`,
    [refs, hashes],
  );
  const done = new Set(existing.map((e) => `${e.source_ref} ${e.source_hash}`));

  const fresh = candidates.filter((c) => !done.has(`${c.id} ${c.contentHash16}`));
  return fresh.slice(0, maxDocs);
}

export async function extractAtomsPhase(
  engine: Engine,
  opts: ExtractAtomsOptions = {},
): Promise<ExtractAtomsResult> {
  const maxDocs = opts.maxDocs ?? DEFAULT_MAX_DOCS;
  const llm = resolveLlmFn(opts.llmFn, opts.modelId ? { modelId: opts.modelId } : {});
  const writePages = opts.storage !== undefined && synthPagesEnabled();
  const result: ExtractAtomsResult = {
    documentsScanned: 0,
    documentsProcessed: 0,
    atomsWritten: 0,
    pagesWritten: 0,
    errors: [],
  };

  const docs = await discoverDocuments(engine, maxDocs);
  result.documentsScanned = docs.length;

  for (const doc of docs) {
    let text: string;
    let modelId: string;
    try {
      const resp = await llm({
        system: SYSTEM_PROMPT,
        // Note body is untrusted — strip injection phrases + cap before the LLM.
        user: `Source: ${doc.id}\n\n---\n\n${sanitizeForPrompt(doc.text, MAX_DOC_CHARS_TO_LLM).text}`,
        maxTokens: 1200,
      });
      text = resp.text;
      modelId = resp.modelId;
    } catch (e) {
      // Fail-open: log + skip this document, never abort the phase.
      result.errors.push(`${doc.id}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }

    const atoms = parseAtomsResponse(text);
    result.documentsProcessed += 1;
    if (atoms.length === 0) continue;

    for (const atom of atoms) {
      const key = atomKey(doc.id, doc.contentHash16, atom.body);
      try {
        await engine.query(
          `INSERT INTO synth_atoms
             (atom_key, source_ref, source_kind, source_hash, title, body, atom_type, concepts, source_quote, lesson, model_id)
           VALUES ($1, $2, 'document', $3, $4, $5, $6, $7::jsonb, $8, $9, $10)
           ON CONFLICT (atom_key) DO NOTHING`,
          [
            key, doc.id, doc.contentHash16, atom.title, atom.body, atom.atom_type,
            JSON.stringify(atom.concepts), atom.source_quote ?? null, atom.lesson ?? null, modelId,
          ],
        );
        result.atomsWritten += 1;
      } catch (e) {
        result.errors.push(`${doc.id} atom write: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }

      // Page mirror — the reference stores every atom as a page; this is what
      // makes atoms retrievable via normal search (the cycle's mirror phase
      // indexes pages into documents/chunks). Idempotent via putPage; a page
      // failure never loses the synth_atoms row.
      if (writePages && opts.storage) {
        const day = new Date().toISOString().slice(0, 10);
        const slug = `atoms/${day}/${slugifyTitle(atom.title)}`;
        const bodyParts = [
          atom.body,
          atom.source_quote ? `\n> ${atom.source_quote}` : "",
          atom.lesson ? `\n**Lesson:** ${atom.lesson}` : "",
          `\n---\nSource: ${doc.id} (${doc.contentHash16})`,
        ].filter(Boolean);
        try {
          await putPage(opts.storage, {
            slug,
            type: "atom",
            allowAdHocType: true,
            title: atom.title,
            markdown_body: bodyParts.join("\n"),
            source_id: doc.sourceId ?? "default",
            written_by: "extract-atoms",
          });
          result.pagesWritten += 1;
        } catch (e) {
          result.errors.push(`${doc.id} atom page: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
  }

  return result;
}
