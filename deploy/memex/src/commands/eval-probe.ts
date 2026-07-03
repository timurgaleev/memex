/**
 * `memex eval-probe` — nightly retrieval-quality snapshot.
 *
 * Replays the captured eval set (eval_queries, via `replayAll`) against the
 * live brain and appends ONE row to `eval_snapshots` (migration 068) so the
 * quality trend is queryable by `doctor` without re-running retrieval.
 *
 * Intended to run once/24h from the systemd timer
 * (deploy/systemd/memex-eval-probe.*). Runs against the live brain, so it is
 * Bedrock-billable for the hybrid arm — keep the eval set small. NEVER promotes
 * the baseline (read-only against the eval set apart from the snapshot append)
 * and NEVER exits non-zero on a quality drop: this is a passive probe, not a CI
 * gate (that is `eval-replay run`). An empty eval set records a zero-scored row
 * and exits 0.
 */
import { Storage } from "../core/storage.ts";
import { loadConfig } from "../core/config.ts";
import { replayAll } from "../core/eval-replay.ts";
import { recordEvalSnapshot } from "../core/eval-snapshot.ts";

export interface EvalProbeOptions {
  /** Cap on queries replayed. Forwarded to replayAll (default 100 there). */
  limit?: number;
}

export async function runEvalProbe(opts: EvalProbeOptions = {}): Promise<void> {
  const config = loadConfig();
  const storage = new Storage(config);
  await storage.init();
  try {
    const replayOpts: Parameters<typeof replayAll>[1] = {};
    if (opts.limit !== undefined) replayOpts.limit = opts.limit;
    const report = await replayAll(storage, replayOpts);
    const { id } = await recordEvalSnapshot(storage.engine(), report);
    console.log(
      JSON.stringify(
        {
          ok: true,
          snapshot_id: id,
          ran_at: report.ranAt,
          total_queries: report.totalQueries,
          scored: report.scored,
          mean_rr: report.meanRR,
          hit_rate: report.hitRate,
        },
        null,
        2,
      ),
    );
  } finally {
    await storage.close();
  }
}
