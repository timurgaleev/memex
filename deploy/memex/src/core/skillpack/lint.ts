/**
 * skillpack/lint.ts — the pack honesty lint.
 *
 * Agents follow served skills literally, so every MCP tool a skill declares
 * and every `memex <cmd> [<sub>]` it tells an agent to run must exist. The
 * lint checks both against the real surfaces (OPERATIONS and CLI_COMMANDS).
 * Command references are only taken from inline code spans and fenced blocks:
 * prose that merely mentions memex is not an instruction to run something.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CLI_COMMANDS, type CliCommandSpec } from "../../cli-commands.ts";
import { OPERATIONS } from "../../mcp/operations.ts";
import { parseSkillFrontmatter } from "./frontmatter.ts";

export type SkillLintRule =
  | "frontmatter-missing"
  | "name-mismatch"
  | "unknown-tool"
  | "unknown-cli-command"
  | "unknown-cli-subcommand";

export interface SkillLintIssue {
  /** Skill slug, or the pack-relative path for `_*.md` / conventions docs. */
  slug: string;
  rule: SkillLintRule;
  detail: string;
  /** 1-based line in the file. */
  line: number;
}

export interface SkillLintResult {
  ok: boolean;
  /** Routable skills linted (shared docs are scanned but not counted). */
  skills: number;
  issues: SkillLintIssue[];
}

export interface SkillLintOptions {
  opNames?: ReadonlySet<string>;
  cliCommands?: Readonly<Record<string, CliCommandSpec>>;
}

export interface CliReference {
  command: string;
  subcommand: string | null;
  line: number;
}

/** Longest token worth reading; a longer one is not a command word. */
const MAX_TOKEN = 64;

function isWordChar(ch: string | undefined): boolean {
  if (ch === undefined) return false;
  return /[\w.-]/.test(ch);
}

function isCommandWord(token: string): boolean {
  return token.length > 0 && token.length <= MAX_TOKEN && /^[a-z][a-z0-9-]*$/.test(token);
}

function stripTrailingPunctuation(token: string): string {
  let end = token.length;
  while (end > 0 && ")];,.:\"'`".includes(token[end - 1]!)) end--;
  return token.slice(0, end);
}

/** Read up to `count` whitespace-separated tokens starting at `from`. */
function readTokens(text: string, from: number, count: number): string[] {
  const tokens: string[] = [];
  let i = from;
  while (tokens.length < count && i < text.length) {
    while (i < text.length && (text[i] === " " || text[i] === "\t")) i++;
    if (i >= text.length) break;
    const start = i;
    while (i < text.length && text[i] !== " " && text[i] !== "\t" && i - start <= MAX_TOKEN) i++;
    // An over-long token is not a word; skip the rest of it without reading
    // it into memory, and stop — whatever follows is not a command line.
    if (i - start > MAX_TOKEN) {
      tokens.push("");
      break;
    }
    tokens.push(text.slice(start, i));
  }
  return tokens;
}

function scanCode(text: string, line: number, out: CliReference[]): void {
  let pos = 0;
  for (;;) {
    const k = text.indexOf("memex", pos);
    if (k === -1) return;
    pos = k + 5;
    if (text[k + 5] !== " ") continue;
    if (k > 0 && isWordChar(text[k - 1])) continue;
    const [first = "", second = ""] = readTokens(text, k + 6, 2);
    const command = stripTrailingPunctuation(first);
    if (!isCommandWord(command)) continue;
    // `memex doctor, then ...` or `memex doctor` inside a quoted example: the
    // punctuation closed the reference, so the next word is prose.
    const closed = command.length !== first.length;
    const sub = closed ? "" : stripTrailingPunctuation(second);
    out.push({ command, subcommand: isCommandWord(sub) ? sub : null, line });
  }
}

/**
 * Where a shell/markdown comment starts on a fenced line (`# ...` at the start
 * or after whitespace); a comment that talks about memex is not a command.
 */
function commentStart(line: string): number {
  let idx = line.indexOf("#");
  while (idx > 0 && line[idx - 1] !== " " && line[idx - 1] !== "\t") {
    idx = line.indexOf("#", idx + 1);
  }
  return idx === -1 ? line.length : idx;
}

/**
 * Collect `memex <cmd> [<sub>]` references from fenced blocks and inline code
 * spans. Linear: fences are tracked line by line, backtick runs are paired
 * through a precomputed next-run-of-the-same-length table, and occurrences
 * are found with indexOf.
 */
export function extractCliReferences(markdown: string, firstLine = 1): CliReference[] {
  const out: CliReference[] = [];
  const lines = markdown.split("\n");
  let fence: string | null = null;
  for (let idx = 0; idx < lines.length; idx++) {
    const raw = lines[idx] ?? "";
    const lineNo = firstLine + idx;
    const t = raw.trimStart();
    const marker = t.startsWith("```") ? "```" : t.startsWith("~~~") ? "~~~" : null;
    if (marker !== null) {
      if (fence === null) fence = marker;
      else if (marker === fence) fence = null;
      continue;
    }
    if (fence !== null) {
      scanCode(raw.slice(0, commentStart(raw)), lineNo, out);
      continue;
    }
    scanInlineSpans(raw, lineNo, out);
  }
  return out;
}

function scanInlineSpans(text: string, line: number, out: CliReference[]): void {
  if (!text.includes("`")) return;
  const runs: { at: number; len: number }[] = [];
  for (let i = 0; i < text.length; ) {
    if (text[i] !== "`") {
      i++;
      continue;
    }
    const at = i;
    while (i < text.length && text[i] === "`") i++;
    runs.push({ at, len: i - at });
  }
  const nextSame = Array.from<number>({ length: runs.length }).fill(-1);
  const seen = new Map<number, number>();
  for (let r = runs.length - 1; r >= 0; r--) {
    const len = runs[r]!.len;
    nextSame[r] = seen.get(len) ?? -1;
    seen.set(len, r);
  }
  for (let r = 0; r < runs.length; ) {
    const close = nextSame[r]!;
    if (close === -1) {
      r++;
      continue;
    }
    const open = runs[r]!;
    scanCode(text.slice(open.at + open.len, runs[close]!.at), line, out);
    r = close + 1;
  }
}

function checkReferences(
  slug: string,
  refs: readonly CliReference[],
  table: Readonly<Record<string, CliCommandSpec>>,
  issues: SkillLintIssue[],
): void {
  for (const ref of refs) {
    const spec = Object.hasOwn(table, ref.command) ? table[ref.command] : undefined;
    if (spec === undefined) {
      issues.push({
        slug,
        rule: "unknown-cli-command",
        detail: `memex ${ref.command}`,
        line: ref.line,
      });
      continue;
    }
    if (ref.subcommand === null || spec.freePositional) continue;
    if (spec.subcommands.includes(ref.subcommand)) continue;
    issues.push({
      slug,
      rule: "unknown-cli-subcommand",
      detail: `memex ${ref.command} ${ref.subcommand}`,
      line: ref.line,
    });
  }
}

function lintSkillFile(
  slug: string,
  text: string,
  opNames: ReadonlySet<string>,
  table: Readonly<Record<string, CliCommandSpec>>,
  issues: SkillLintIssue[],
): void {
  const fm = parseSkillFrontmatter(text);
  if (fm === null) {
    issues.push({
      slug,
      rule: "frontmatter-missing",
      detail: "skill must open with a `---` frontmatter block",
      line: 1,
    });
    checkReferences(slug, extractCliReferences(text), table, issues);
    return;
  }
  if (fm.name !== slug) {
    issues.push({
      slug,
      rule: "name-mismatch",
      detail: fm.name === null ? "frontmatter has no name" : `name '${fm.name}' is not the slug`,
      line: fm.keyLines["name"] ?? 1,
    });
  }
  for (const tool of fm.tools) {
    if (opNames.has(tool)) continue;
    issues.push({
      slug,
      rule: "unknown-tool",
      detail: tool,
      line: fm.keyLines["tools"] ?? 1,
    });
  }
  // Descriptions and triggers are served too, so the frontmatter is scanned
  // for command references along with the body.
  checkReferences(slug, extractCliReferences(text), table, issues);
}

function readText(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/**
 * Lint a skill pack directory. Routable skills (`<slug>.md` or
 * `<slug>/SKILL.md`, the layouts listBrainSkillpacks serves) get the full
 * contract check; the shared `_*.md` docs and `conventions/*.md` are served
 * through get_skill as well, so they are scanned for command references.
 */
export function lintSkillpack(skillsDir: string, opts: SkillLintOptions = {}): SkillLintResult {
  const opNames = opts.opNames ?? new Set(OPERATIONS.map((o) => o.name));
  const table = opts.cliCommands ?? CLI_COMMANDS;
  if (!existsSync(skillsDir)) {
    throw new Error(`skillpack lint: skills directory not found at ${skillsDir}`);
  }
  const issues: SkillLintIssue[] = [];
  let skills = 0;
  const names = readdirSync(skillsDir).sort();
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const full = join(skillsDir, name);
    if (name === "conventions") {
      for (const doc of readdirSync(full).sort()) {
        if (!doc.endsWith(".md")) continue;
        const text = readText(join(full, doc));
        if (text !== null) checkReferences(`conventions/${doc}`, extractCliReferences(text), table, issues);
      }
      continue;
    }
    if (name.startsWith("_")) {
      if (!name.endsWith(".md")) continue;
      const text = readText(full);
      if (text !== null) checkReferences(name, extractCliReferences(text), table, issues);
      continue;
    }
    let slug: string;
    let file: string;
    if (name.endsWith(".md")) {
      slug = name.slice(0, -3);
      file = full;
    } else {
      slug = name;
      file = join(full, "SKILL.md");
      if (!existsSync(file)) continue;
    }
    const text = readText(file);
    if (text === null) continue;
    skills++;
    lintSkillFile(slug, text, opNames, table, issues);
  }
  return { ok: issues.length === 0, skills, issues };
}
