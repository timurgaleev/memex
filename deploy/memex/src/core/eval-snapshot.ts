/**
 * Eval snapshots (migration 068) — durable history for the nightly retrieval-
 * quality probe.
 *
 * `replayAll` (core/eval-replay.ts) produces a ReplayReport when the captured
 * eval set is replayed against the live brain. The nightly probe
 * (deploy/systemd/memex-eval-probe.*) calls it once/24h and appends ONE row
 * here via {@link recordEvalSnapshot}, so `doctor` can read the trend
 * ({@link latestEvalSnapshot}) without re-running retrieval.
 *
 * Append-only: nothing updates a row. A zero-scored run (empty eval set) still
 * records, so "no eval queries yet" is distinguishable from "probe never ran".
 */
import type { Engine } from "./engine/interface.ts";
import type { ReplayReport } from "./eval-replay.ts";

export interface EvalSnapshotRow {
  id: number;
  ran_at: string;
  total_queries: number;
  scored: number;
  mean_rr: number;
  hit_rate: number;
  detail: Record<string, unknown>;
}

/**
 * Append one snapshot row from a replay report. The scalar columns
 * (mean_rr/hit_rate/scored) are the trend axes; `detail` keeps the baseline +
 * stability blocks as JSON so a reader gets the full picture without a schema
 * change per metric. Returns the new row id.
 */
export async function recordEvalSnapshot(
  engine: Engine,
  report: ReplayReport,
): Promise<{ id: number }> {
  const detail: Record<string, unknown> = { ok: report.ok };
  if (report.baseline) detail.baseline = report.baseline;
  if (report.stability) detail.stability = report.stability;
  const r = await engine.query<{ id: number }>(
    `INSERT INTO eval_snapshots
       (ran_at, total_queries, scored, mean_rr, hit_rate, detail)
     VALUES ($1::timestamptz, $2, $3, $4, $5, $6::jsonb)
     RETURNING id`,
    [
      report.ranAt,
      report.totalQueries,
      report.scored,
      report.meanRR,
      report.hitRate,
      JSON.stringify(detail),
    ],
  );
  return { id: r.rows[0]!.id };
}

/**
 * Most-recent snapshot, or null when the probe has never run (or the table
 * predates migration 068). Degrades to null on an undefined-table error so a
 * doctor read on an old brain doesn't crash.
 */
export async function latestEvalSnapshot(
  engine: Engine,
): Promise<EvalSnapshotRow | null> {
  try {
    const r = await engine.query<EvalSnapshotRow>(
      `SELECT id, ran_at::text AS ran_at, total_queries, scored,
              mean_rr, hit_rate, detail
         FROM eval_snapshots
        ORDER BY ran_at DESC, id DESC
        LIMIT 1`,
    );
    return r.rows[0] ?? null;
  } catch (e) {
    const code = (e as { code?: string } | null)?.code;
    const msg = (e as { message?: string } | null)?.message ?? "";
    if (code === "42P01" || /relation .*eval_snapshots.* does not exist/i.test(msg)) {
      return null;
    }
    throw e;
  }
}
