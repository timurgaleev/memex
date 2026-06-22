/**
 * lint phase — periodic frontmatter-conformance audit over the corpus.
 *
 * Read-only: it surfaces how many documents violate the lint ruleset
 * (core/lint.ts) so the conformance debt is visible each cycle. The
 * frontmatter-inference phase is what actually fixes the violations; this phase
 * just measures. A non-empty `flagged` count makes the phase report `warn`.
 */
import type { Engine } from "../engine/interface.ts";
import { lintCorpus } from "../lint.ts";

export interface LintPhaseResult {
  scanned: number;
  flagged: number;
  summary: Record<string, number>;
}

export async function lintPhase(engine: Engine): Promise<LintPhaseResult> {
  const report = await lintCorpus(engine);
  return {
    scanned: report.totalScanned,
    flagged: report.issues.length,
    summary: report.summary,
  };
}
