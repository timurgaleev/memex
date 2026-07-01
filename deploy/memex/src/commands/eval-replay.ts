/**
 * `memex eval-replay <subcommand>` — capture / list / replay.
 *
 * Subcommands:
 *   capture <id> --query "..." --tag good|bad
 *                [--expected-doc D] [--k N] [--source S] [--notes N]
 *      Persist a query into the eval set. Re-running with the same id
 *      updates in place.
 *
 *   list [--tag T] [--limit N]
 *      Show captured queries (most recent first).
 *
 *   delete <id>
 *      Drop a query from the eval set.
 *
 *   run [--tag T] [--limit N] [--promote]
 *      Replay all captured queries against the live brain. Prints a
 *      report including deltas vs the persisted baseline. `--promote`
 *      overwrites the baseline columns with the latest run.
 */
import { Storage } from "../core/storage.ts";
import { loadConfig } from "../core/config.ts";
import {
  recordQuery,
  listQueries,
  deleteQuery,
  replayAll,
  type EvalSearchMode,
  type EvalTag,
} from "../core/eval-replay.ts";

export type EvalReplaySub = "capture" | "list" | "delete" | "run";

/** Minimum baseline drop (in mean-RR / hit-rate points) that counts as a
 *  regression for the `run` CI gate. A small epsilon absorbs run-to-run
 *  jitter so the gate fires on real drops, not noise. Override with
 *  `EVAL_REPLAY_REGRESSION_EPS` (a non-negative number). */
export const DEFAULT_EVAL_REGRESSION_EPS = 0.01;

export function evalRegressionEps(
  raw: string | undefined = process.env["EVAL_REPLAY_REGRESSION_EPS"],
): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_EVAL_REGRESSION_EPS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_EVAL_REGRESSION_EPS;
}

/** Pure predicate: does a replay report signal a CI-gating regression?
 *  A run with a baseline whose mean-RR or hit-rate dropped by more than `eps`
 *  regresses; a --promote run and a baseline-less first run never do. */
export function isReplayRegression(
  report: { baseline?: { deltaMeanRR: number; deltaHitRate: number } },
  opts: { promote?: boolean; eps?: number } = {},
): boolean {
  if (opts.promote || !report.baseline) return false;
  const eps = opts.eps ?? evalRegressionEps();
  return (
    report.baseline.deltaMeanRR < -eps || report.baseline.deltaHitRate < -eps
  );
}

export interface EvalReplayCmdOptions {
  sub: EvalReplaySub;
  // capture
  id?: string;
  query?: string;
  tag?: EvalTag;
  expectedDocId?: string;
  k?: number;
  source?: string;
  notes?: string;
  searchMode?: EvalSearchMode;
  // list / run
  limit?: number;
  filterTag?: EvalTag;
  // run
  promote?: boolean;
}

export async function runEvalReplay(opts: EvalReplayCmdOptions): Promise<void> {
  const config = loadConfig();
  const storage = new Storage(config);
  await storage.init();
  try {
    const engine = storage.engine();
    switch (opts.sub) {
      case "capture": {
        if (!opts.id) throw new Error("eval-replay capture: <id> is required");
        if (!opts.query) throw new Error("eval-replay capture: --query is required");
        if (!opts.tag) throw new Error("eval-replay capture: --tag is required");
        const recordOpts: Parameters<typeof recordQuery>[1] = {
          id: opts.id,
          query: opts.query,
          tag: opts.tag,
        };
        if (opts.k !== undefined) recordOpts.k = opts.k;
        if (opts.expectedDocId) recordOpts.expectedDocId = opts.expectedDocId;
        if (opts.source) recordOpts.source = opts.source;
        if (opts.notes) recordOpts.notes = opts.notes;
        if (opts.searchMode) recordOpts.searchMode = opts.searchMode;
        const row = await recordQuery(engine, recordOpts);
        console.log(JSON.stringify({ ok: true, query: row }, null, 2));
        return;
      }
      case "list": {
        const listOpts: Parameters<typeof listQueries>[1] = {};
        if (opts.filterTag) listOpts.tag = opts.filterTag;
        if (opts.limit !== undefined) listOpts.limit = opts.limit;
        const rows = await listQueries(engine, listOpts);
        console.log(JSON.stringify({ ok: true, count: rows.length, rows }, null, 2));
        return;
      }
      case "delete": {
        if (!opts.id) throw new Error("eval-replay delete: <id> is required");
        const ok = await deleteQuery(engine, opts.id);
        console.log(JSON.stringify({ ok, id: opts.id }, null, 2));
        if (!ok) process.exitCode = 1;
        return;
      }
      case "run": {
        const replayOpts: Parameters<typeof replayAll>[1] = {};
        if (opts.filterTag) replayOpts.tag = opts.filterTag;
        if (opts.limit !== undefined) replayOpts.limit = opts.limit;
        if (opts.promote) replayOpts.promote = true;
        const report = await replayAll(storage, replayOpts);
        console.log(JSON.stringify(report, null, 2));
        // CI regression gate: a run WITH a baseline that dropped meaningfully
        // (mean reciprocal-rank or hit-rate below the persisted baseline by more
        // than EVAL_REPLAY_REGRESSION_EPS) exits 1 so a pipeline can block the
        // merge. Skipped for --promote (that intentionally rewrites the baseline)
        // and when there is no baseline yet (first run has nothing to regress
        // against). Retrieval quality is otherwise a silent-drift class.
        if (isReplayRegression(report, { ...(opts.promote ? { promote: true } : {}) })) {
          const b = report.baseline!;
          console.error(
            `eval-replay: REGRESSION vs baseline — deltaMeanRR=${b.deltaMeanRR.toFixed(4)}, ` +
              `deltaHitRate=${b.deltaHitRate.toFixed(4)} (eps=${evalRegressionEps()})`,
          );
          process.exitCode = 1;
        }
        return;
      }
      default: {
        const _exhaustive: never = opts.sub;
        throw new Error(`eval-replay: unknown subcommand '${_exhaustive}'`);
      }
    }
  } finally {
    await storage.close();
  }
}
