/**
 * `memex lint` — frontmatter conformance over the indexed corpus.
 *
 * Thin CLI wrapper over `core/lint.ts` (the shared ruleset, also run by the
 * `lint` cycle phase). Surfaces violations as JSON; read-only.
 */
import { Storage } from "../core/storage.ts";
import { loadConfig } from "../core/config.ts";
import { lintCorpus, type LintIssue } from "../core/lint.ts";

export type { LintIssue };

export async function runLint(): Promise<void> {
  const config = loadConfig();
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
