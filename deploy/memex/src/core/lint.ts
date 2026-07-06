/**
 * Lint core — frontmatter conformance over the indexed corpus.
 *
 * Rules (stable, in-code rather than config):
 *   1. frontmatter.title is a non-empty string
 *   2. frontmatter.tags is an array or string
 *   3. frontmatter.created exists
 *   4. frontmatter.updated exists
 *
 * Read-only: it reports violations; the frontmatter-inference cycle phase is
 * what fixes them in bulk. Shared by the `memex lint` CLI and the `lint` cycle
 * phase so both apply the identical ruleset.
 */
import type { Engine } from "./engine/interface.ts";

export interface LintIssue {
  documentId: string;
  sourcePath: string;
  rules: string[];
}

export interface LintReport {
  ok: boolean;
  totalScanned: number;
  issues: LintIssue[];
  summary: Record<string, number>;
}

interface DocRow {
  id: string;
  source_path: string;
  frontmatter: Record<string, unknown> | null;
}

/** Lint a single frontmatter object → list of broken-rule keys. */
export function lintFrontmatter(fm: Record<string, unknown> | null): string[] {
  const f = fm ?? {};
  const broken: string[] = [];
  if (typeof f["title"] !== "string" || f["title"].length === 0) {
    broken.push("title-missing");
  }
  if (!Array.isArray(f["tags"]) && typeof f["tags"] !== "string") {
    broken.push("tags-missing");
  }
  if (!f["created"]) broken.push("created-missing");
  if (!f["updated"]) broken.push("updated-missing");
  return broken;
}

/** Scan every document's frontmatter and return a conformance report. */
export async function lintCorpus(engine: Engine): Promise<LintReport> {
  const r = await engine.query<DocRow>(
    `SELECT id, source_path, frontmatter FROM documents`,
  );
  const issues: LintIssue[] = [];
  for (const d of r.rows) {
    const broken = lintFrontmatter(d.frontmatter);
    if (broken.length > 0) {
      issues.push({ documentId: d.id, sourcePath: d.source_path, rules: broken });
    }
  }
  return {
    ok: issues.length === 0,
    totalScanned: r.rows.length,
    issues,
    summary: summariseLint(issues),
  };
}

export function summariseLint(issues: LintIssue[]): Record<string, number> {
  const tally: Record<string, number> = {};
  for (const i of issues) {
    for (const rule of i.rules) tally[rule] = (tally[rule] ?? 0) + 1;
  }
  return tally;
}

// ── File-content lint (reference parity) ────────────────────────────────────
//
// Deterministic page-quality rules over RAW markdown text — LLM artifacts,
// placeholder dates, missing frontmatter, broken citations, empty sections —
// plus an auto-repair for the fixable subset. Zero LLM calls. Used by
// `memex lint <dir|file> [--fix]`; the DB-corpus `lintCorpus` above stays the
// cycle phase's ruleset.

export interface ContentLintIssue {
  file: string;
  line: number;
  rule: string;
  message: string;
  fixable: boolean;
}

// Punctuation is [.!]? — the artifact class the docstrings name is
// "Of course! Here is..." and the enthusiastic bang is the common form.
const LLM_PREAMBLES = [
  /^Of course[.!]?\s*Here is (?:a |the )?(?:detailed |comprehensive |updated )?page[^.\n]*\.?\s*\n*/gim,
  /^Certainly[.!]?\s*Here is[^.\n]*\.?\s*\n*/gim,
  /^Here is (?:a |the )?(?:detailed |comprehensive |updated )?page[^.\n]*\.?\s*\n*/gim,
  /^I've (?:created|updated|written|prepared) (?:a |the )?(?:detailed |comprehensive )?page[^.\n]*\.?\s*\n*/gim,
  /^Sure[.!,]?\s*Here (?:is|are)[^.\n]*\.?\s*\n*/gim,
  /^Absolutely[.!]?\s*Here[^.\n]*\.?\s*\n*/gim,
];

/** Lint raw markdown content → deterministic issue list (pure). */
export function lintContent(content: string, filePath: string): ContentLintIssue[] {
  const issues: ContentLintIssue[] = [];
  const lines = content.split("\n");

  // LLM preamble artifacts ("Of course! Here is ...").
  for (const pattern of LLM_PREAMBLES) {
    pattern.lastIndex = 0;
    if (pattern.test(content)) {
      issues.push({
        file: filePath,
        line: 1,
        rule: "llm-preamble",
        message: 'LLM preamble artifact detected (e.g., "Of course! Here is...")',
        fixable: true,
      });
    }
  }

  // Whole page wrapped in ```markdown fences (LLM artifact).
  if (content.match(/^```(?:markdown|md)\s*\n/m) && content.match(/\n```\s*$/m)) {
    issues.push({
      file: filePath,
      line: 1,
      rule: "code-fence-wrap",
      message: "Page wrapped in ```markdown code fences (LLM artifact)",
      fixable: true,
    });
  }

  // Placeholder dates left unfilled.
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (/\bYYYY-MM-DD\b/.test(l) || /\bXX-XX\b/.test(l) || /\b\d{4}-XX-XX\b/.test(l)) {
      issues.push({
        file: filePath,
        line: i + 1,
        rule: "placeholder-date",
        message: `Placeholder date found: ${l.trim().slice(0, 60)}`,
        fixable: false,
      });
    }
  }

  // Frontmatter presence + required fields.
  if (content.startsWith("---")) {
    const fmEnd = content.indexOf("---", 3);
    if (fmEnd > 0) {
      const fm = content.slice(3, fmEnd);
      if (!/^title:/m.test(fm)) {
        issues.push({
          file: filePath,
          line: 1,
          rule: "missing-title",
          message: "Frontmatter missing required field: title",
          fixable: false,
        });
      }
      if (!/^type:/m.test(fm)) {
        issues.push({
          file: filePath,
          line: 1,
          rule: "missing-type",
          message: "Frontmatter missing required field: type",
          fixable: false,
        });
      }
      if (!/^created:/m.test(fm)) {
        issues.push({
          file: filePath,
          line: 1,
          rule: "missing-created",
          message: "Frontmatter missing required field: created",
          fixable: false,
        });
      }
    }
  } else {
    issues.push({
      file: filePath,
      line: 1,
      rule: "no-frontmatter",
      message: "Page has no YAML frontmatter",
      fixable: false,
    });
  }

  // Unclosed [Source: ...] citations.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (
      /\[Source:[^\]]*$/.test(line) &&
      !(i + 1 < lines.length && /^\s*[^[]*\]/.test(lines[i + 1]!))
    ) {
      issues.push({
        file: filePath,
        line: i + 1,
        rule: "broken-citation",
        message: "Unclosed [Source: ...] citation",
        fixable: false,
      });
    }
  }

  // Empty / stub sections.
  const sectionPattern = /^##\s+(.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = sectionPattern.exec(content)) !== null) {
    const start = m.index + m[0].length;
    const nextSection = content.indexOf("\n## ", start);
    const body = content.slice(start, nextSection > 0 ? nextSection : undefined).trim();
    if (body === "" || body === "[No data yet]" || body === "*[To be filled by agent]*") {
      const lineNum = content.slice(0, m.index).split("\n").length;
      issues.push({
        file: filePath,
        line: lineNum,
        rule: "empty-section",
        message: `Empty section: ## ${m[1]}`,
        fixable: false,
      });
    }
  }

  return issues;
}

/** Auto-repair the fixable issues (LLM preambles, code-fence wrap). Pure. */
export function fixContent(content: string): string {
  let fixed = content;
  for (const pattern of LLM_PREAMBLES) {
    pattern.lastIndex = 0;
    fixed = fixed.replace(pattern, "");
  }
  // Unwrap a whole page the LLM fenced in ```markdown … ``` — but ONLY as a
  // matched pair. Stripping the trailing ``` unconditionally would corrupt a
  // page that legitimately ENDS in a real fenced code block.
  if (/^```(?:markdown|md)\s*\n/.test(fixed) && /\n```\s*$/.test(fixed)) {
    fixed = fixed.replace(/^```(?:markdown|md)\s*\n/, "");
    fixed = fixed.replace(/\n```\s*$/, "");
  }
  // Collapse the blank-line craters the removals leave behind.
  fixed = fixed.replace(/\n{3,}/g, "\n\n");
  return fixed.trim() + "\n";
}
