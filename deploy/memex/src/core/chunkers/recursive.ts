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

  return {
    frontmatter,
    title: findFirstH1(body),
    chunks: merged,
  };
}
