/**
 * Contextual-retrieval embed wrapper — the LLM-FREE minimal tier.
 *
 * Prepends a `<context>{title}\n{synopsis}\n</context>\n` prefix to a chunk's
 * text JUST BEFORE embedding, per the published contextual-retrieval method:
 * a short document-level context header lifts a bare chunk's cross-chunk
 * recall without the chunk having to restate its own document's topic. The
 * wrapper is built just-in-time at the embed call and NEVER persisted as the
 * canonical `chunks.content` — search snippets, the keyword arm, and debug all
 * read the unchanged chunk text. Only the vector the embedder returns reflects
 * the prefix.
 *
 * Default-OFF: callers wrap only when `MEMEX_CONTEXTUAL_RETRIEVAL` is set. A
 * chunk from a code document ALWAYS bypasses wrapping — a markdown title in
 * front of a code block does not help cross-modal retrieval and only wastes
 * embedding tokens.
 *
 * The synopsis in THIS tier is deterministic — the first two sentences of the
 * page body via `extractFirstTwoSentences`. There is NO LLM call here; the
 * paid per-chunk-synopsis tier is deferred and NOT built.
 *
 * Ported from the reference's contextual-retrieval wrapper helpers
 * (`buildContextualPrefix` / `wrapChunkForEmbedding` / title+synopsis
 * sanitization / `extractFirstTwoSentences`, ref embedding-context.ts:54-171).
 * memex has no shared CJK module, so the CJK sentence delimiters are inlined
 * (the same BMP set the reference kept in its `cjk.ts`); the reference's
 * `modeRequiresHaiku` / `modeRequiresWrapper` guards belong to the deferred
 * paid tier and are intentionally omitted.
 *
 * SANITIZER SCOPE: `sanitizeTitle`/`sanitizeSynopsis` only strip the closing
 * `</context>` tag + collapse whitespace + cap length — enough to keep a title
 * from breaking the wrapper's own tag for the EMBEDDER input, which is all this
 * LLM-free tier needs (the wrapped text is never sent to a chat model). They are
 * NOT a substitute for `core/llm/sanitize.ts`; the deferred paid per-chunk
 * synopsis tier MUST run `sanitizeForPrompt` on any text it feeds to a model.
 */

/** Env flag — a chunk is wrapped for embedding only when this is set. Stable
 *  contract name; the caller (indexer / reindex --contextual) reads it. */
export const CONTEXTUAL_RETRIEVAL_FLAG = "MEMEX_CONTEXTUAL_RETRIEVAL";

/** True when the operator opted the embed path into contextual wrapping. */
export function contextualRetrievalEnabled(
  raw: string | undefined = process.env[CONTEXTUAL_RETRIEVAL_FLAG],
): boolean {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
}

/**
 * Hard cap on the title-only block per chunk. Generous — high-signal titles
 * are typically 30-80 chars; the cap only protects against pathological
 * frontmatter. (ref embedding-context.ts:33)
 */
export const TITLE_HARD_CAP_CHARS = 300;

/**
 * Hard cap on the per-page summary lifted via `extractFirstTwoSentences`.
 * Keeps the embedding payload bounded even when the first two sentences are
 * unusually long. (ref embedding-context.ts:40)
 */
export const SUMMARY_HARD_CAP_CHARS = 300;

/**
 * CJK sentence delimiters (BMP set: 。！？). Inlined because memex has no
 * shared CJK module; matches the reference's `CJK_SENTENCE_DELIMITERS`.
 */
const CJK_SENTENCE_DELIMITERS = ["。", "！", "？"];

export interface ContextualPrefixOptions {
  /** A code-document chunk always bypasses wrapping (returns null). */
  isCode?: boolean;
}

/**
 * Build the `<context>...</context>\n` prefix for a chunk.
 *
 *   title set, synopsis empty  → `<context>{title}\n</context>\n`
 *   title empty, synopsis set  → `<context>\n{synopsis}\n</context>\n`
 *   both set                   → `<context>{title}\n{synopsis}\n</context>\n`
 *   both null/empty            → null (caller embeds the raw chunk)
 *   opts.isCode                → null (code bypass, always)
 *
 * The wrapper text is asymmetric (document side only): queries embed clean, so
 * the prefix never lands on the query arm. Ported from
 * ref embedding-context.ts:54-97 (buildContextualPrefix + the fenced-code
 * bypass folded in here rather than in a separate wrap step).
 */
export function buildContextualPrefix(
  title: string | null | undefined,
  synopsis: string | null | undefined,
  opts: ContextualPrefixOptions = {},
): string | null {
  if (opts.isCode) return null;

  const safeTitle = sanitizeTitle(title ?? "");
  const safeSynopsis = sanitizeSynopsis(synopsis ?? "");

  if (!safeTitle && !safeSynopsis) return null;
  if (safeTitle && !safeSynopsis) return `<context>${safeTitle}\n</context>\n`;
  if (!safeTitle && safeSynopsis) return `<context>\n${safeSynopsis}\n</context>\n`;
  return `<context>${safeTitle}\n${safeSynopsis}\n</context>\n`;
}

/**
 * Apply a prefix to a chunk for the embedding call ONLY.
 *
 *   opts.isCode  → passthrough (code bypass)
 *   prefix null   → passthrough (nothing to wrap)
 *   else          → prefix + chunkText
 *
 * Invariant: use this for the embedding INPUT only. The original chunk text
 * MUST land in `chunks.content` unchanged (ref embedding-context.ts:85-97).
 */
export function wrapChunkForEmbedding(
  chunkText: string,
  prefix: string | null,
  opts: ContextualPrefixOptions = {},
): string {
  if (opts.isCode) return chunkText;
  if (prefix == null) return chunkText;
  return prefix + chunkText;
}

/**
 * Strip injection vectors + collapse whitespace from a title.
 *
 *   - `</context>` would close the wrapper tag prematurely → stripped
 *   - newlines / tabs collapse to a single space (titles shouldn't be
 *     multi-line; defensive against frontmatter oddities)
 *   - trim + cap at TITLE_HARD_CAP_CHARS
 *
 * (ref embedding-context.ts:107-114)
 */
export function sanitizeTitle(title: string): string {
  if (!title) return "";
  return title
    .replace(/<\/context>/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, TITLE_HARD_CAP_CHARS);
}

/**
 * Same sanitization as title plus the summary cap. Strips `</context>` so a
 * synopsis lifted from body prose can never break out of the wrapper tag.
 * (ref embedding-context.ts:121-128)
 */
export function sanitizeSynopsis(synopsis: string): string {
  if (!synopsis) return "";
  return synopsis
    .replace(/<\/context>/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, SUMMARY_HARD_CAP_CHARS);
}

/**
 * Pure regex first-two-sentences extractor. Handles English `.!?` followed by
 * whitespace AND the CJK `。！？` delimiters. Hard-capped at
 * SUMMARY_HARD_CAP_CHARS so a single run-on sentence can't blow the payload.
 * (ref embedding-context.ts:139-167)
 */
export function extractFirstTwoSentences(text: string): string {
  if (!text) return "";

  const cjkDelims = CJK_SENTENCE_DELIMITERS.map(escapeRegex).join("");
  const sentenceEnd = new RegExp(`([.!?])\\s+|([${cjkDelims}])`, "g");

  let sentenceCount = 0;
  let lastEnd = text.length;
  for (const match of text.matchAll(sentenceEnd)) {
    sentenceCount++;
    const matchEnd = (match.index ?? 0) + match[0].length;
    if (sentenceCount === 2) {
      lastEnd = matchEnd;
      break;
    }
  }

  if (sentenceCount === 0) {
    return text.trim().slice(0, SUMMARY_HARD_CAP_CHARS);
  }
  return text.slice(0, lastEnd).trim().slice(0, SUMMARY_HARD_CAP_CHARS);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
