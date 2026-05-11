/**
 * `memex lint` — frontmatter conformance over the indexed corpus.
 *
 * Rules (kept in code rather than a config file because they're stable):
 *   1. document.frontmatter.title is non-empty
 *   2. document.frontmatter.tags is an array (may be empty)
 *   3. document.frontmatter.created exists
 *   4. document.frontmatter.updated exists
 *
 * Surfaces violations as JSON. Read-only; the dedicated frontmatter
 * inference cycle phase is what fixes them in bulk.
 */
import { Storage } from "../core/storage.ts";
import { loadConfig } from "../core/config.ts";

interface DocRow {
  id: string;
  source_path: string;
  frontmatter: Record<string, unknown> | null;
}

export interface LintIssue {
  documentId: string;
  sourcePath: string;
  rules: string[];
}

export async function runLint(): Promise<void> {
  const config = loadConfig();
  const storage = new Storage(config);
  await storage.init();
  try {
    const r = await storage.engine().query<DocRow>(
      `SELECT id, source_path, frontmatter FROM documents`,
    );
    const issues: LintIssue[] = [];
    for (const d of r.rows) {
      const fm = (d.frontmatter as Record<string, unknown> | null) ?? {};
      const broken: string[] = [];
      if (typeof fm["title"] !== "string" || fm["title"].length === 0) {
        broken.push("title-missing");
      }
      if (!Array.isArray(fm["tags"]) && typeof fm["tags"] !== "string") {
        broken.push("tags-missing");
      }
      if (!fm["created"]) broken.push("created-missing");
      if (!fm["updated"]) broken.push("updated-missing");
      if (broken.length > 0) {
        issues.push({
          documentId: d.id,
          sourcePath: d.source_path,
          rules: broken,
        });
      }
    }
    console.log(
      JSON.stringify(
        {
          ok: issues.length === 0,
          totalScanned: r.rows.length,
          issues,
          summary: summarise(issues),
        },
        null,
        2,
      ),
    );
    if (issues.length > 0) process.exitCode = 1;
  } finally {
    await storage.close();
  }
}

function summarise(issues: LintIssue[]): Record<string, number> {
  const tally: Record<string, number> = {};
  for (const i of issues) {
    for (const r of i.rules) {
      tally[r] = (tally[r] ?? 0) + 1;
    }
  }
  return tally;
}
