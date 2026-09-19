/**
 * Routing benchmark: the `routing-eval.jsonl` files the skill pack ships, read
 * as test cases for "given this request, which skill should run?".
 *
 * A file lives only at `<skillsDir>/<slug>/routing-eval.jsonl` and is read
 * only when it is a regular file: the slug is checked against the skill-slug
 * grammar before it is joined into a path, and a symlink is refused rather
 * than followed out of the pack.
 *
 * The split into train and held-out is deterministic and per file: cases are
 * ordered by sha256(slug, intent) and the first ceil(30%) are held out, so
 * every file contributes at least one held-out case and the same case lands
 * on the same side on every machine and every run.
 */
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const ROUTING_EVAL_FILE = "routing-eval.jsonl";
export const MAX_BENCHMARK_FILE_BYTES = 64 * 1024;
export const MAX_BENCHMARK_LINE_CHARS = 4096;
export const MAX_CASES_PER_FILE = 500;
export const MAX_INTENT_CHARS = 500;
export const MAX_AMBIGUOUS_WITH = 16;
export const HELDOUT_FRACTION = 0.3;

const SLUG_MAX = 64;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export type Split = "train" | "heldout";

export interface RoutingCase {
  /** The skill whose file the case came from. */
  skill: string;
  /** 1-based line in that file. */
  line: number;
  intent: string;
  /** null: a negative case, where no skill should be picked. */
  expected_skill: string | null;
  ambiguous_with: string[];
  split: Split;
}

export interface BenchmarkLoad {
  cases: RoutingCase[];
  /** `<slug>/routing-eval.jsonl:<line>: <problem>`, one per rejected line or file. */
  errors: string[];
}

export function isSkillSlug(value: unknown): value is string {
  return typeof value === "string" && value.length <= SLUG_MAX && SLUG_RE.test(value);
}

function parseLine(
  slug: string,
  lineNo: number,
  raw: string,
): { ok: true; value: Omit<RoutingCase, "split"> } | { ok: false; error: string } {
  const where = `${slug}/${ROUTING_EVAL_FILE}:${lineNo}`;
  if (raw.length > MAX_BENCHMARK_LINE_CHARS) {
    return { ok: false, error: `${where}: line exceeds ${MAX_BENCHMARK_LINE_CHARS} chars` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: `${where}: invalid JSON (${e instanceof Error ? e.message : String(e)})` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: `${where}: expected a JSON object` };
  }
  const o = parsed as Record<string, unknown>;
  const intent = typeof o.intent === "string" ? o.intent.trim() : "";
  if (intent.length === 0 || intent.length > MAX_INTENT_CHARS) {
    return { ok: false, error: `${where}: intent must be 1..${MAX_INTENT_CHARS} chars` };
  }
  // An explicit null marks a negative case; a missing field is a mistake.
  const expected = o.expected_skill;
  if (expected !== null && !isSkillSlug(expected)) {
    return { ok: false, error: `${where}: expected_skill is not a skill slug or null` };
  }
  let ambiguous: string[] = [];
  if (o.ambiguous_with !== undefined) {
    const a = o.ambiguous_with;
    if (!Array.isArray(a) || a.length > MAX_AMBIGUOUS_WITH || !a.every(isSkillSlug)) {
      return {
        ok: false,
        error: `${where}: ambiguous_with must be at most ${MAX_AMBIGUOUS_WITH} skill slugs`,
      };
    }
    ambiguous = [...new Set(a as string[])];
  }
  return {
    ok: true,
    value: { skill: slug, line: lineNo, intent, expected_skill: expected, ambiguous_with: ambiguous },
  };
}

function splitKey(skill: string, intent: string): string {
  return createHash("sha256").update(`${skill}\n${intent}`).digest("hex");
}

/** Order a file's cases by hash and hold out the first ceil(30%). Pure. */
export function assignSplits(cases: ReadonlyArray<Omit<RoutingCase, "split">>): RoutingCase[] {
  const bySkill = new Map<string, Array<Omit<RoutingCase, "split">>>();
  for (const c of cases) {
    const list = bySkill.get(c.skill) ?? [];
    list.push(c);
    bySkill.set(c.skill, list);
  }
  const out: RoutingCase[] = [];
  for (const skill of [...bySkill.keys()].sort()) {
    const keyed = bySkill
      .get(skill)!
      .map((c) => ({ c, key: splitKey(c.skill, c.intent) }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.c.line - b.c.line));
    const heldout = Math.ceil(keyed.length * HELDOUT_FRACTION);
    keyed.forEach(({ c }, i) => out.push({ ...c, split: i < heldout ? "heldout" : "train" }));
  }
  return out;
}

/**
 * Load one skill's benchmark. A bad slug, a missing file, a symlink or an
 * oversized file is a file-level error; a bad line is reported with its
 * number and skipped.
 */
export function loadSkillBenchmark(skillsDir: string, slug: string): BenchmarkLoad {
  if (!isSkillSlug(slug)) return { cases: [], errors: [`${JSON.stringify(slug)}: not a skill slug`] };
  const file = join(skillsDir, slug, ROUTING_EVAL_FILE);
  const where = `${slug}/${ROUTING_EVAL_FILE}`;
  let size: number;
  try {
    // The skill directory itself must not be a link either: lstat on the file
    // alone would follow a linked directory out of the pack.
    const dir = lstatSync(join(skillsDir, slug));
    const st = lstatSync(file);
    if (!dir.isDirectory() || st.isSymbolicLink() || !st.isFile()) {
      return { cases: [], errors: [`${where}: not a regular file`] };
    }
    size = st.size;
  } catch {
    return { cases: [], errors: [`${where}: not found`] };
  }
  if (size > MAX_BENCHMARK_FILE_BYTES) {
    return { cases: [], errors: [`${where}: file exceeds ${MAX_BENCHMARK_FILE_BYTES} bytes`] };
  }
  const text = readFileSync(file, "utf8");
  const parsed: Array<Omit<RoutingCase, "split">> = [];
  const errors: string[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = (lines[i] ?? "").trim();
    if (raw.length === 0 || raw.startsWith("//")) continue;
    if (parsed.length >= MAX_CASES_PER_FILE) {
      errors.push(`${where}:${i + 1}: more than ${MAX_CASES_PER_FILE} cases; the rest is ignored`);
      break;
    }
    const r = parseLine(slug, i + 1, raw);
    if (r.ok) parsed.push(r.value);
    else errors.push(r.error);
  }
  return { cases: assignSplits(parsed), errors };
}

/** Slugs under `skillsDir` with something at the benchmark path, sorted. */
export function listBenchmarkSkills(skillsDir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(skillsDir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of names) {
    if (!isSkillSlug(name)) continue;
    // Anything at the path is listed, links included, so the loader reports a
    // refused file instead of it silently dropping out of the benchmark.
    try {
      lstatSync(join(skillsDir, name, ROUTING_EVAL_FILE));
      out.push(name);
    } catch {
      // no benchmark for this skill
    }
  }
  return out.sort();
}

/** Every benchmark in the pack. */
export function loadPackBenchmark(skillsDir: string): BenchmarkLoad & { files: string[] } {
  const files = listBenchmarkSkills(skillsDir);
  const cases: RoutingCase[] = [];
  const errors: string[] = [];
  for (const slug of files) {
    const r = loadSkillBenchmark(skillsDir, slug);
    cases.push(...r.cases);
    errors.push(...r.errors);
  }
  return { cases, errors, files };
}
