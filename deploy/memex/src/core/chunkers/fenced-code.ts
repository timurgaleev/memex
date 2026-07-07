/**
 * Fenced-code extraction. Pulls ```lang code fences out of a markdown page so
 * each example can be chunked by the tree-sitter code chunker and ranked as
 * code, not prose. Only fences whose info-string tag maps to a grammar memex
 * actually parses are returned; everything else stays as ordinary prose in the
 * markdown chunker. Bounded by `MEMEX_MAX_FENCES_PER_PAGE` (default 100) so a
 * pathological page can't fan out into an unbounded embedding bill.
 */
import type { CodeLanguage } from "./parsers.ts";

/** Fence info-string tag (and common aliases) → tree-sitter grammar. */
const FENCE_TAG_TO_LANG: Record<string, CodeLanguage> = {
  ts: "typescript",
  typescript: "typescript",
  tsx: "tsx",
  py: "python",
  python: "python",
  sh: "bash",
  bash: "bash",
  shell: "bash",
  go: "go",
  golang: "go",
  sql: "sql",
};

const DEFAULT_MAX_FENCES = 100;

function resolveMaxFences(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseInt(env.MEMEX_MAX_FENCES_PER_PAGE ?? "", 10);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_FENCES;
}

export interface FencedBlock {
  lang: CodeLanguage;
  source: string;
}

/**
 * Extract supported-language fenced code blocks from markdown, in document
 * order, capped at `MEMEX_MAX_FENCES_PER_PAGE`. Handles ``` and ~~~ fences with
 * an info string; the closing fence must match the opener's run and sit at line
 * start (standard CommonMark).
 */
export function extractFencedCode(markdown: string): FencedBlock[] {
  if (typeof markdown !== "string" || !/[`~]{3}/.test(markdown)) return [];
  const cap = resolveMaxFences();
  const out: FencedBlock[] = [];
  // Group 1: opening run (``` or ~~~, 3+). Group 2: info tag. Group 3: body.
  const re = /^([`~]{3,})[ \t]*([A-Za-z0-9_+-]*)[^\n]*\n([\s\S]*?)^\1[ \t]*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown)) !== null) {
    const tag = (m[2] ?? "").toLowerCase();
    const lang = FENCE_TAG_TO_LANG[tag];
    const source = m[3] ?? "";
    if (lang && source.trim().length > 0) {
      out.push({ lang, source });
      if (out.length >= cap) break;
    }
  }
  return out;
}
