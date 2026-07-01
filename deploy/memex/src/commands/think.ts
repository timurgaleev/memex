/**
 * `memex think` — answer a question by paid Sonnet synthesis across the brain,
 * bounded by a USD budget. Opt-in, default-OFF (set MEMEX_THINK=1 to run live),
 * the deep-synthesis slice of the agent-layer reference parity.
 *
 * Thin CLI wrapper over runThink: open storage, synthesize, print the answer
 * (or the structured report with --json).
 */
import { Storage } from "../core/storage.ts";
import { loadConfig } from "../core/config.ts";
import { runThink } from "../core/synthesis/think.ts";

export interface ThinkCliArgs {
  question: string;
  k?: number;
  maxTakes?: number;
  maxBudgetUsd?: number;
  json?: boolean;
}

export async function runThinkCli(args: ThinkCliArgs): Promise<void> {
  const storage = new Storage(loadConfig());
  await storage.init();
  try {
    const report = await runThink(storage, {
      question: args.question,
      ...(args.k !== undefined ? { k: args.k } : {}),
      ...(args.maxTakes !== undefined ? { maxTakes: args.maxTakes } : {}),
      ...(args.maxBudgetUsd !== undefined ? { maxBudgetUsd: args.maxBudgetUsd } : {}),
    });
    if (args.json) {
      console.log(JSON.stringify(report));
      return;
    }
    if (!report.ran) {
      console.log(`think: skipped — ${report.reason}`);
      return;
    }
    if (!report.synthesis) {
      console.log(
        `think: no synthesis — ${report.reason ?? "model output did not parse"}` +
          ` (${report.pagesGathered} pages, ${report.takesGathered} takes, spent $${report.spentUsd.toFixed(4)})`,
      );
      return;
    }
    const s = report.synthesis;
    console.log(s.answer);
    if (s.gaps.length > 0) {
      console.log(`\nGaps:\n${s.gaps.map((g) => `  - ${g}`).join("\n")}`);
    }
    console.log(
      `\n[${report.pagesGathered} pages, ${report.takesGathered} takes, ` +
        `${s.citations.length} citations, spent $${report.spentUsd.toFixed(4)}` +
        (report.budgetExhausted ? ", budget exhausted" : "") +
        `]`,
    );
  } finally {
    await storage.close();
  }
}
