/**
 * Recursive markdown chunker — heading + paragraph + size-bounded splitter.
 *
 * Strategy:
 *   1. Parse + strip YAML frontmatter (delegated to ../frontmatter.ts).
 *   2. Split the body by H1 / H2 boundaries — each becomes one section.
 *   3. If a section exceeds `maxChars`, sub-split by paragraph; pack
 *      paragraphs greedily into chunks <= maxChars.
 *   4. Merge any chunk shorter than `minChars` with its next sibling.
 *
 * Char-bounded (not token-bounded) on purpose: no tokenizer dependency,
 * Bedrock Titan is character-tolerant, and chunk sizing has loose tails
 * by design.
 *
 * This is the only chunker that actually runs today. `code.ts` and
 * `semantic.ts` are stubs for future content types.
 */
import { parseFrontmatter } from "../frontmatter.ts";
export { parseFrontmatter };

export interface ChunkerOptions {
  /** Soft upper bound per chunk in characters. Default ≈ 4000 chars (~1000 tokens). */
  maxChars?: number;
  /** Anything shorter than this gets merged with its neighbour. */
  minChars?: number;
  /**
   * Sliding-window overlap (chars) prepended to each chunk from the tail of the
   * previous one, so a fact straddling a size-split boundary stays retrievable
   * from both sides. Applied ONLY between the size-driven sub-splits of one
   * heading section -- never across a heading boundary (a heading is a semantic
   * break, not an arbitrary cut). Snapped to a sentence/word boundary and capped
   * at half the previous chunk so it never duplicates a majority of a chunk.
   * Default comes from `MEMEX_CHUNK_OVERLAP` (default 0 = OFF, byte-identical to
   * the no-overlap behavior; existing indexes are unchanged until re-indexed).
   */
  overlapChars?: number;
}

export interface ChunkedDocument {
  /** Parsed frontmatter (raw object — not validated here). */
  frontmatter: Record<string, unknown>;
  /** Body title — first H1 if present, else null. */
  title: string | null;
  /** The chunked body, in document order. */
  chunks: string[];
}

const DEFAULT_MAX = 4000;
const DEFAULT_MIN = 200;
/** Below this many chars an overlap window is not worth prepending. */
const MIN_OVERLAP_CHARS = 16;

/**
 * Resolve the overlap window: explicit option wins, else `MEMEX_CHUNK_OVERLAP`,
 * else 0 (OFF). A non-numeric / negative env value fails SAFE to 0 (chunking
 * must never break indexing). Capped at half of `maxChars` so overlap can never
 * dominate a chunk.
 */
export function resolveOverlapChars(
  opt: number | undefined,
  maxChars: number,
): number {
  let v = opt;
  if (v === undefined) {
    const raw = process.env.MEMEX_CHUNK_OVERLAP;
    v = raw === undefined ? 0 : Number.parseInt(raw, 10);
  }
  if (!Number.isFinite(v) || v <= 0) return 0;
  return Math.min(Math.floor(v), Math.floor(maxChars / 2));
}

/**
 * The overlap text to prepend to a chunk: the tail of the previous chunk,
 * capped at `overlapChars` AND at half the previous chunk, snapped FORWARD to a
 * clean start. Preference: the FIRST sentence boundary in the capped window
 * (intentionally first-not-last, so the bridge is generous up to the cap), then
 * a word boundary, else "". The fallback chain matters: a window whose first
 * sentence start leaves too little, or a window with no whitespace at all (one
 * giant token / URL / hash), must not produce a sub-floor or mid-token bridge.
 */
export function overlapTail(prev: string, overlapChars: number): string {
  const cap = Math.min(overlapChars, Math.floor(prev.length / 2));
  if (cap < MIN_OVERLAP_CHARS) return "";
  const window = prev.slice(prev.length - cap);
  const candidates: string[] = [];
  const sentence = window.search(/(?<=[.!?])\s+/);
  if (sentence >= 0) candidates.push(window.slice(sentence).replace(/^\s+/, ""));
  const word = window.search(/\s/);
  if (word >= 0) candidates.push(window.slice(word + 1));
  for (const c of candidates) {
    const t = c.trim();
    if (t.length >= MIN_OVERLAP_CHARS) return t;
  }
  return "";
}

/**
 * True if a chunk contains an H1/H2 heading line ANYWHERE (`m` flag). A normal
 * size-split continuation carries no heading (the heading rode with the
 * section's first piece). A leading heading marks a section start; an EMBEDDED
 * heading marks a chunk that mergeShort folded across a section boundary. Either
 * way the chunk must not receive an overlap bridge -- it would cross a section.
 * Uses the same `/^#{1,2}\s/` grammar as `sectionsByHeading`, so it agrees with
 * how the chunker decides boundaries in the first place.
 */
function containsHeading(chunk: string): boolean {
  return /^#{1,2}\s/m.test(chunk);
}

/**
 * Prepend a sliding-window overlap to each FINAL chunk that is a pure size-split
 * continuation -- i.e. a chunk that carries NO heading line. A chunk holding a
 * heading (leading = section start, or embedded = a mergeShort cross-section
 * merge) is skipped, so an overlap window never bridges a section boundary.
 *
 * Applied AFTER mergeShort over the final chunk list, so it changes chunk
 * CONTENT only, never the chunk COUNT: mergeShort decides boundaries on the
 * original (un-overlapped) lengths, keeping positional chunk ids stable vs the
 * overlap-off output. The overlap is read from the ORIGINAL previous chunk (not
 * the already-overlapped `out`), so windows do not compound.
 */
function addOverlap(chunks: string[], overlapChars: number): string[] {
  if (overlapChars <= 0 || chunks.length <= 1) return chunks;
  const out: string[] = [chunks[0] ?? ""];
  for (let i = 1; i < chunks.length; i++) {
    const chunk = chunks[i] ?? "";
    if (containsHeading(chunk)) {
      out.push(chunk);
      continue;
    }
    const tail = overlapTail(chunks[i - 1] ?? "", overlapChars);
    out.push(tail ? `${tail}\n\n${chunk}` : chunk);
  }
  return out;
}

/**
 * Split markdown body into sections at H1 (`# `) and H2 (`## `) boundaries.
 * The heading line itself is included in the section that follows it.
 */
function sectionsByHeading(body: string): string[] {
  const lines = body.split(/\r?\n/);
  const out: string[] = [];
  let buf: string[] = [];
  for (const line of lines) {
    if (/^#{1,2}\s/.test(line) && buf.length > 0) {
      out.push(buf.join("\n"));
      buf = [];
    }
    buf.push(line);
  }
  if (buf.length > 0) out.push(buf.join("\n"));
  return out.filter((s) => s.trim().length > 0);
}

/**
 * Sub-split a single section that exceeds maxChars by paragraph (blank-line
 * separated). Greedily packs paragraphs until the budget is reached.
 */
function splitBySize(section: string, maxChars: number): string[] {
  if (section.length <= maxChars) return [section];
  const paragraphs = section.split(/\r?\n\s*\r?\n/).filter(Boolean);
  const out: string[] = [];
  let current = "";
  for (const p of paragraphs) {
    if (current.length === 0) {
      current = p;
      continue;
    }
    if (current.length + 2 + p.length <= maxChars) {
      current = current + "\n\n" + p;
    } else {
      out.push(current);
      current = p;
    }
  }
  if (current.length > 0) out.push(current);
  return out;
}

/**
 * Merge any chunk shorter than minChars with the next one to avoid
 * embedding tiny fragments that just dilute search recall.
 */
function mergeShort(chunks: string[], minChars: number): string[] {
  if (chunks.length <= 1) return chunks;
  const out: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const cur = chunks[i] ?? "";
    if (cur.length < minChars && i + 1 < chunks.length) {
      const next = chunks[i + 1] ?? "";
      chunks[i + 1] = cur + "\n\n" + next;
      continue;
    }
    out.push(cur);
  }
  return out;
}

function findFirstH1(body: string): string | null {
  const m = body.match(/^#\s+(.+)$/m);
  return m && m[1] ? m[1].trim() : null;
}

export function chunkMarkdown(
  md: string,
  opts: ChunkerOptions = {},
): ChunkedDocument {
  const maxChars = opts.maxChars ?? DEFAULT_MAX;
  const minChars = opts.minChars ?? DEFAULT_MIN;
  const overlapChars = resolveOverlapChars(opts.overlapChars, maxChars);

  const { frontmatter, body } = parseFrontmatter(md);
  const sections = sectionsByHeading(body);

  const expanded: string[] = [];
  for (const sec of sections) {
    for (const piece of splitBySize(sec, maxChars)) {
      expanded.push(piece.trim());
    }
  }
  const merged = mergeShort(
    expanded.filter((s) => s.length > 0),
    minChars,
  );
  // Overlap is the LAST step, over the final chunk list: it bridges size-split
  // continuations without changing the chunk count mergeShort produced (so
  // positional chunk ids stay stable vs overlap-off), and the heading-start
  // skip keeps a window from ever crossing a section boundary.
  const chunks = addOverlap(merged, overlapChars);

  return {
    frontmatter,
    title: findFirstH1(body),
    chunks,
  };
}
