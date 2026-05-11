/**
 * `memex reports [--since N]` — render trend report from cycle_snapshots.
 *
 * Reads the table populated by the snapshot phase of the cycle. Returns:
 *   - latest counts
 *   - delta vs N hours ago (default 24)
 *   - mean cycle duration if cycle_results table exists
 */
import { Storage } from "../core/storage.ts";
import { loadConfig } from "../core/config.ts";

export interface ReportsOptions {
  /** Window in hours to compute deltas against. Default 24. */
  sinceHours?: number;
}

export async function runReports(opts: ReportsOptions = {}): Promise<void> {
  const sinceHours = opts.sinceHours ?? 24;
  if (!Number.isFinite(sinceHours) || sinceHours < 1 || sinceHours > 24 * 30) {
    throw new Error(`memex reports: invalid --since ${sinceHours}`);
  }
  const config = loadConfig();
  const storage = new Storage(config);
  await storage.init();
  try {
    const e = storage.engine();
    const exists = await e.query<{ regclass: string | null }>(
      `SELECT to_regclass('cycle_snapshots')::text AS regclass`,
    );
    if (!exists.rows[0]?.regclass) {
      console.log(
        JSON.stringify(
          {
            ok: false,
            error: "cycle_snapshots table not present — has migration 003 run?",
          },
          null,
          2,
        ),
      );
      return;
    }

    const latest = await e.query<{
      captured_at: string;
      documents: number;
      chunks: number;
      embeddings: number;
      entities: number;
      entity_mentions: number;
    }>(
      `SELECT captured_at::text, documents, chunks, embeddings, entities, entity_mentions
       FROM cycle_snapshots ORDER BY captured_at DESC LIMIT 1`,
    );
    const baseline = await e.query<{
      documents: number;
      chunks: number;
      embeddings: number;
      entities: number;
      entity_mentions: number;
    }>(
      `SELECT documents, chunks, embeddings, entities, entity_mentions
       FROM cycle_snapshots
       WHERE captured_at < NOW() - ($1 || ' hours')::interval
       ORDER BY captured_at DESC LIMIT 1`,
      [String(sinceHours)],
    );
    const total = await e.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM cycle_snapshots`,
    );

    const cur = latest.rows[0];
    const base = baseline.rows[0];
    const deltas = cur && base
      ? {
          documents: cur.documents - base.documents,
          chunks: cur.chunks - base.chunks,
          embeddings: cur.embeddings - base.embeddings,
          entities: cur.entities - base.entities,
          entity_mentions: cur.entity_mentions - base.entity_mentions,
        }
      : null;

    console.log(
      JSON.stringify(
        {
          ok: true,
          sinceHours,
          totalSnapshots: total.rows[0]?.c ?? 0,
          latest: cur ?? null,
          deltas,
        },
        null,
        2,
      ),
    );
  } finally {
    await storage.close();
  }
}
