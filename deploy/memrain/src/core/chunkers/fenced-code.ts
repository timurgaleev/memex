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
 * Index every line that could close a fence, keyed by the run it closes.
 *
 * A closing line is a fence run followed by nothing but spaces/tabs, so the run
 * it closes is unambiguous: the greedy `[`~]{3,}` takes the whole run, and any
 * shorter prefix would leave a fence char sitting where `[ \t]*$` needs the end
 * of the line.
 *
 * This index is what keeps the scan linear. The matcher's body is lazy, so an
 * opener whose closer does not exist walks to the end of the page before it
 * gives up — and a page of unclosed openers pays that walk once per line. On
 * "```a\n" repeated that measured 27 s at 500 KB and 107 s at 1 MB, x4 per
 * doubling. Consulting the index first means every match we attempt is one we
 * already know succeeds, so the bodies we actually walk are disjoint and the
 * whole pass is linear.
 */
function indexClosingFences(markdown: string): Map<string, number[]> {
  const re = /^([`~]{3,})[ \t]*$/gm;
  const byRun = new Map<string, number[]>();
  for (let m = re.exec(markdown); m !== null; m = re.exec(markdown)) {
    const run = m[1] ?? "";
    const at = byRun.get(run);
    if (at) at.push(m.index);
    else byRun.set(run, [m.index]);
  }
  return byRun;
}

/**
 * Which run would actually close an opener whose run is `run`, at or after
 * `from`? Null when nothing does.
 *
 * The matcher gives group 1 back one character at a time, so an opener of four
 * backticks closed by three is a real match — and the LONGEST prefix that has a
 * closer is the one it settles on. Answering that here is what lets the caller
 * pin the run: a length with no closer costs a walk to the end of the page, and
 * "````ts" wrapping "```py" pays that walk on every opener. Left to backtrack
 * on its own the matcher ran 370 ms at 125 KB and 23.7 s at 1 MB, x4 per
 * doubling, even with the openers themselves already filtered.
 *
 * Real pages have one or two distinct closing runs; the length and position
 * checks skip the rest before the prefix compare.
 */
function closingRun(byRun: Map<string, number[]>, run: string, from: number): string | null {
  let best: string | null = null;
  for (const [closer, at] of byRun) {
    if (closer.length > run.length) continue;
    if (best !== null && closer.length <= best.length) continue;
    // Collected in document order, so the last entry is the latest one.
    if ((at[at.length - 1] ?? -1) < from) continue;
    if (run.startsWith(closer)) best = closer;
  }
  return best;
}

/**
 * The matcher, with the fence run pinned to a literal instead of a captured
 * group plus backreference. Pinning is what removes the give-back: the run is
 * one we already know closes, so group 1 (the info tag) and group 2 (the body)
 * are reached once. `run` is a slice of a `[`~]{3,}` match, so it holds nothing
 * that needs escaping.
 */
function matcherFor(cache: Map<string, RegExp>, run: string): RegExp {
  const hit = cache.get(run);
  if (hit) return hit;
  const re = new RegExp(
    `^${run}[ \\t]*(?![ \\t])([\\w+-]*)(?![\\w+-])[^\\n]*\\n([\\s\\S]*?)^${run}[ \\t]*$`,
    "gm",
  );
  cache.set(run, re);
  return re;
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
  const closers = indexClosingFences(markdown);
  const matchers = new Map<string, RegExp>();
  // Candidate openers: the only positions where a fence can start.
  const opener = /^([`~]{3,})/gm;
  let pos = 0;
  while (out.length < cap) {
    opener.lastIndex = pos;
    const candidate = opener.exec(markdown);
    if (candidate === null) break;
    const start = candidate.index;
    // The info line must be terminated: `[^\n]*\n` needs a newline after the
    // opener. With none left, no later position can match either.
    const eol = markdown.indexOf("\n", start);
    if (eol < 0) break;
    // Resolve the closing run before matching. An opener with no closer is
    // skipped outright, and one that does close is matched against that run
    // alone — either way nothing walks the page looking for a fence that is
    // not there, so the bodies we do walk are disjoint.
    const run = closingRun(closers, candidate[1] ?? "", eol + 1);
    if (run === null) {
      pos = start + 1;
      continue;
    }
    // Group 1: info tag. Group 2: body. The two negative lookaheads pin the
    // indent and the tag to their maximal run. They cannot change any capture
    // — everything up to the newline is swallowed by `[^\n]*` either way — but
    // without them the three quantifiers on the info line can trade characters,
    // and a 32 K info string took 478 ms.
    const re = matcherFor(matchers, run);
    re.lastIndex = start;
    const m = re.exec(markdown);
    if (m === null) {
      pos = start + 1;
      continue;
    }
    const tag = (m[1] ?? "").toLowerCase();
    const lang = FENCE_TAG_TO_LANG[tag];
    const source = m[2] ?? "";
    if (lang && source.trim().length > 0) out.push({ lang, source });
    pos = re.lastIndex;
  }
  return out;
}
