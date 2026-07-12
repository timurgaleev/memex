/**
 * `memex lint [<dir|file.md>] [--fix] [--dry-run]` — page quality lint.
 *
 * Two modes:
 *   - no target: the original DB-corpus frontmatter conformance report
 *     (`core/lint.ts` lintCorpus — also the cycle lint phase's ruleset).
 *   - with a target: deterministic FILE lint — LLM
 *     preamble artifacts, ```markdown fence wraps, placeholder dates, missing
 *     frontmatter fields, broken citations, empty sections. `--fix` repairs
 *     the fixable subset in place; `--fix --dry-run` previews without writing.
 */
import { readFileSync, writeFileSync, readdirSync, statSync, lstatSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { Storage } from "../core/storage.ts";
import { loadConfig } from "../core/config.ts";
import {
  lintCorpus,
  lintContent,
  fixContent,
  type LintIssue,
  type ContentLintIssue,
} from "../core/lint.ts";

export type { LintIssue, ContentLintIssue };

export interface LintCmdOptions {
  /** Directory or single .md file. Absent → DB-corpus report. */
  target?: string;
  fix?: boolean;
  dryRun?: boolean;
  configPath?: string;
}

export interface FileLintResult {
  ok: boolean;
  pagesScanned: number;
  pagesWithIssues: number;
  totalIssues: number;
  totalFixed: number;
  dryRun: boolean;
  issues: ContentLintIssue[];
}

function collectPages(dir: string): string[] {
  const pages: string[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d)) {
      if (entry.startsWith(".") || entry.startsWith("_")) continue;
      const full = join(d, entry);
      if (lstatSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".md")) pages.push(full);
    }
  };
  walk(dir);
  return pages.sort();
}

/** File-mode lint core (exported for tests — no console, no exit). */
export function lintFiles(
  target: string,
  opts: { fix?: boolean; dryRun?: boolean } = {},
): FileLintResult {
  if (!existsSync(target)) {
    throw new Error(`memex lint: not found: ${target}`);
  }
  const isSingleFile = statSync(target).isFile();
  const pages = isSingleFile ? [target] : collectPages(target);

  const all: ContentLintIssue[] = [];
  let pagesWithIssues = 0;
  let totalFixed = 0;
  for (const page of pages) {
    const content = readFileSync(page, "utf-8");
    const relPath = isSingleFile ? page : relative(target, page);
    const issues = lintContent(content, relPath);
    if (issues.length === 0) continue;
    pagesWithIssues++;
    all.push(...issues);
    if (opts.fix && issues.some((i) => i.fixable)) {
      const fixed = fixContent(content);
      if (fixed !== content) {
        totalFixed += issues.filter((i) => i.fixable).length;
        if (!opts.dryRun) writeFileSync(page, fixed);
      }
    }
  }
  return {
    ok: all.length === 0,
    pagesScanned: pages.length,
    pagesWithIssues,
    totalIssues: all.length,
    totalFixed,
    dryRun: !!opts.dryRun,
    issues: all,
  };
}

export async function runLint(opts: LintCmdOptions = {}): Promise<void> {
  if (opts.target) {
    const result = lintFiles(opts.target, {
      ...(opts.fix ? { fix: true } : {}),
      ...(opts.dryRun ? { dryRun: true } : {}),
    });
    console.log(JSON.stringify(result, null, 2));
    // CI-gate semantics: unresolved issues → exit 1. A real --fix run gets
    // credit for what it repaired; a dry run / report-only does not.
    const repaired = opts.fix && !opts.dryRun ? result.totalFixed : 0;
    if (result.totalIssues - repaired > 0) {
      process.exitCode = 1;
    }
    return;
  }

  const config = loadConfig(opts.configPath);
  const storage = new Storage(config);
  await storage.init();
  try {
    const report = await lintCorpus(storage.engine());
    console.log(JSON.stringify(report, null, 2));
    if (report.issues.length > 0) process.exitCode = 1;
  } finally {
    await storage.close();
  }
}
