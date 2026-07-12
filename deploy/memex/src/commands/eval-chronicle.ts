/**
 * `memex eval chronicle [--json]` — deterministic Life Chronicle feature eval.
 *
 * Brings its own in-memory PGLite (a throwaway temp dir), so it needs no config
 * and no gateway and runs anywhere as a CI fixture gate. Exit 0 iff every task
 * passes.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../core/storage.ts";
import { runChronicleEval } from "../eval/chronicle-harness.ts";

const HELP = `Usage: memex eval chronicle [--json]

Deterministic Life Chronicle feature eval. Builds a synthetic month corpus with
a known gold chronology, a planted ontology supersession, and a planted standing
conflict, then scores the chronicle layer on: day reconstruction (intra-day
order), last-seen date, ontology supersession + --asof time-travel, conflict
surfacing, and source isolation. Zero LLM, brings its own DB.

Exit code 0 iff every task passes.
`;

export async function runEvalChronicle(args: string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(HELP);
    return 0;
  }
  const json = args.includes("--json");
  const tmp = mkdtempSync(join(tmpdir(), "memex-eval-chronicle-"));
  const storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  try {
    const result = await runChronicleEval(storage);
    if (json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stderr.write(
        `[eval chronicle] ${result.passed}/${result.total} tasks passed ` +
          `(score ${(result.score * 100).toFixed(0)}%)\n`,
      );
      for (const t of result.tasks) {
        process.stderr.write(`  ${t.passed ? "PASS" : "FAIL"} ${t.id} — ${t.detail}\n`);
      }
    }
    return result.score === 1 ? 0 : 1;
  } finally {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  }
}
