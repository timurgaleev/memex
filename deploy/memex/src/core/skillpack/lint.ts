/**
 * skillpack/lint.ts — the pack honesty lint.
 *
 * Agents follow served skills literally, so every MCP tool a skill declares
 * and every `memex <cmd> [<sub>]` it tells an agent to run must exist. The
 * lint checks both against the real surfaces (OPERATIONS and CLI_COMMANDS).
 * Tool-call examples (`tool_name {json}`, `memex call tool '{json}'`) are
 * checked too: dispatch refuses undeclared argument keys, so an example that
 * uses one teaches the agent a call that always fails.
 * References are only taken from inline code spans and fenced blocks: prose
 * that merely mentions memex is not an instruction to run something.
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
  | "unknown-cli-subcommand"
  | "unknown-call-tool"
  | "unknown-tool-arg"
  | "unreadable";

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
  /** Declared argument keys per tool; a tool missing here is not key-checked. */
  opParams?: ReadonlyMap<string, ReadonlySet<string>>;
  cliCommands?: Readonly<Record<string, CliCommandSpec>>;
}

export interface CliReference {
  command: string;
  subcommand: string | null;
  line: number;
}

export interface ToolCallExample {
  tool: string;
  /** Top-level keys of the example's argument object, in order. */
  keys: string[];
  /** True for `memex call <tool>`, where the tool name itself must exist. */
  viaCli: boolean;
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

type SegmentVisitor = (code: string, line: number) => void;

/**
 * Hand every code segment — fenced lines (minus a trailing comment) and inline
 * code spans — to `visit`. Linear: fences are tracked line by line and
 * backtick runs are paired through a precomputed next-run-of-the-same-length
 * table.
 */
function forEachCodeSegment(markdown: string, firstLine: number, visit: SegmentVisitor): void {
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
      visit(raw.slice(0, commentStart(raw)), lineNo);
      continue;
    }
    forEachInlineSpan(raw, lineNo, visit);
  }
}

/** Collect `memex <cmd> [<sub>]` references from fenced blocks and inline code spans. */
export function extractCliReferences(markdown: string, firstLine = 1): CliReference[] {
  const out: CliReference[] = [];
  forEachCodeSegment(markdown, firstLine, (code, line) => scanCode(code, line, out));
  return out;
}

function forEachInlineSpan(text: string, line: number, visit: SegmentVisitor): void {
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
    visit(text.slice(open.at + open.len, runs[close]!.at), line);
    r = close + 1;
  }
}

function isToolChar(ch: string | undefined): boolean {
  return ch !== undefined && ((ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9") || ch === "_");
}

function isToolName(token: string): boolean {
  return token.length > 0 && token.length <= MAX_TOKEN && /^[a-z][a-z0-9_]*$/.test(token);
}

/**
 * Top-level keys of the object opening at `open`, and where the scan stopped.
 * Lenient on purpose: examples carry placeholders (`[...]`, `ID`, `...`) that
 * are not JSON, so only `"key":` pairs at depth 1 are read.
 */
function objectKeys(text: string, open: number): { keys: string[]; end: number } {
  const keys: string[] = [];
  let depth = 0;
  let i = open;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === "{" || ch === "[") {
      depth++;
      i++;
      continue;
    }
    if (ch === "}" || ch === "]") {
      depth--;
      i++;
      if (depth === 0) break;
      continue;
    }
    if (ch !== "\"") {
      i++;
      continue;
    }
    const start = i + 1;
    i = start;
    while (i < text.length && text[i] !== "\"") i += text[i] === "\\" ? 2 : 1;
    const key = text.slice(start, i);
    i++;
    if (depth !== 1) continue;
    let j = i;
    while (text[j] === " " || text[j] === "\t") j++;
    if (text[j] === ":") keys.push(key);
  }
  return { keys, end: i };
}

function scanToolCalls(text: string, line: number, opNames: ReadonlySet<string>, out: ToolCallExample[]): void {
  // `memex call <tool> ['{json}']`: the tool name is an instruction on its own.
  const cliObjects = new Map<number, number>();
  let pos = 0;
  for (;;) {
    const k = text.indexOf("memex call", pos);
    if (k === -1) break;
    pos = k + 10;
    if (k > 0 && isWordChar(text[k - 1])) continue;
    if (text[k + 10] !== " ") continue;
    const [first = "", second = ""] = readTokens(text, k + 11, 2);
    const tool = stripTrailingPunctuation(first);
    if (!isToolName(tool)) continue;
    const example: ToolCallExample = { tool, keys: [], viaCli: true, line };
    out.push(example);
    if (tool.length !== first.length || !second.startsWith("'{")) continue;
    cliObjects.set(text.indexOf("'{", k + 11 + first.length) + 1, out.length - 1);
  }
  // `tool_name {json}`, plus the objects of the `memex call` lines above. An
  // object nested inside one already read is an argument value, not a call.
  let scannedUntil = 0;
  for (let b = text.indexOf("{"); b !== -1; b = text.indexOf("{", b + 1)) {
    if (b < scannedUntil) continue;
    const cli = cliObjects.get(b);
    if (cli !== undefined) {
      const { keys, end } = objectKeys(text, b);
      out[cli]!.keys = keys;
      scannedUntil = end;
      continue;
    }
    let w = b;
    while (w > 0 && (text[w - 1] === " " || text[w - 1] === "\t")) w--;
    if (w === b) continue;
    const nameEnd = w;
    while (w > 0 && nameEnd - w <= MAX_TOKEN && isToolChar(text[w - 1])) w--;
    if (w > 0 && isWordChar(text[w - 1])) continue;
    const tool = text.slice(w, nameEnd);
    if (!opNames.has(tool)) continue;
    const { keys, end } = objectKeys(text, b);
    out.push({ tool, keys, viaCli: false, line });
    scannedUntil = end;
  }
}

/**
 * Collect tool-call examples from fenced blocks and inline code spans: every
 * `memex call <tool>`, and every `<tool> {json}` whose tool is in `opNames`.
 * Linear: each `{` is looked back from once over the gap since the previous
 * one, and an argument object is read once.
 */
export function extractToolCalls(
  markdown: string,
  opNames: ReadonlySet<string>,
  firstLine = 1,
): ToolCallExample[] {
  const out: ToolCallExample[] = [];
  forEachCodeSegment(markdown, firstLine, (code, line) => scanToolCalls(code, line, opNames, out));
  return out;
}

function checkToolCalls(
  slug: string,
  calls: readonly ToolCallExample[],
  opNames: ReadonlySet<string>,
  opParams: ReadonlyMap<string, ReadonlySet<string>>,
  issues: SkillLintIssue[],
): void {
  for (const call of calls) {
    if (!opNames.has(call.tool)) {
      if (call.viaCli) {
        issues.push({ slug, rule: "unknown-call-tool", detail: `memex call ${call.tool}`, line: call.line });
      }
      continue;
    }
    const declared = opParams.get(call.tool);
    if (declared === undefined) continue;
    for (const key of call.keys) {
      if (declared.has(key)) continue;
      issues.push({ slug, rule: "unknown-tool-arg", detail: `${call.tool} ${key}`, line: call.line });
    }
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

interface PackSurfaces {
  opNames: ReadonlySet<string>;
  opParams: ReadonlyMap<string, ReadonlySet<string>>;
  table: Readonly<Record<string, CliCommandSpec>>;
}

/** Command references and tool-call examples: the checks every served doc gets. */
function checkBody(slug: string, text: string, surfaces: PackSurfaces, issues: SkillLintIssue[]): void {
  checkReferences(slug, extractCliReferences(text), surfaces.table, issues);
  checkToolCalls(slug, extractToolCalls(text, surfaces.opNames), surfaces.opNames, surfaces.opParams, issues);
}

function lintSkillFile(slug: string, text: string, surfaces: PackSurfaces, issues: SkillLintIssue[]): void {
  const fm = parseSkillFrontmatter(text);
  if (fm === null) {
    issues.push({
      slug,
      rule: "frontmatter-missing",
      detail: "skill must open with a `---` frontmatter block",
      line: 1,
    });
    checkBody(slug, text, surfaces, issues);
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
    if (surfaces.opNames.has(tool)) continue;
    issues.push({
      slug,
      rule: "unknown-tool",
      detail: tool,
      line: fm.keyLines["tools"] ?? 1,
    });
  }
  // Descriptions and triggers are served too, so the frontmatter is scanned
  // for command references along with the body.
  checkBody(slug, text, surfaces, issues);
}

/**
 * Read a pack file. A file that exists but cannot be read is an issue, not a
 * skip: the server would fail to serve it, and a silently skipped skill would
 * let the lint pass on a pack it never checked.
 */
function readText(file: string, slug: string, issues: SkillLintIssue[]): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    issues.push({ slug, rule: "unreadable", detail: code ?? String(e), line: 1 });
    return null;
  }
}

function declaredParams(): Map<string, ReadonlySet<string>> {
  return new Map(OPERATIONS.map((o) => [o.name, new Set(Object.keys(o.params))]));
}

/**
 * Lint a skill pack directory. Routable skills (`<slug>.md` or
 * `<slug>/SKILL.md`, the layouts listBrainSkillpacks serves) get the full
 * contract check; the shared `_*.md` docs and `conventions/*.md` are served
 * through get_skill as well, so they get the command and tool-call checks.
 */
export function lintSkillpack(skillsDir: string, opts: SkillLintOptions = {}): SkillLintResult {
  const surfaces: PackSurfaces = {
    opNames: opts.opNames ?? new Set(OPERATIONS.map((o) => o.name)),
    opParams: opts.opParams ?? declaredParams(),
    table: opts.cliCommands ?? CLI_COMMANDS,
  };
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
        const slug = `conventions/${doc}`;
        const text = readText(join(full, doc), slug, issues);
        if (text !== null) checkBody(slug, text, surfaces, issues);
      }
      continue;
    }
    if (name.startsWith("_")) {
      if (!name.endsWith(".md")) continue;
      const text = readText(full, name, issues);
      if (text !== null) checkBody(name, text, surfaces, issues);
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
    skills++;
    const text = readText(file, slug, issues);
    if (text === null) continue;
    lintSkillFile(slug, text, surfaces, issues);
  }
  return { ok: issues.length === 0, skills, issues };
}
