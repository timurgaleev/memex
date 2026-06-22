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
