/**
 * snapshot phase — record stats counters every cycle so `reports`
 * can render trends.
 *
 * Writes to a `cycle_snapshots` table created on first run by 005_cycle_snapshots
 * migration. Until that migration ships, snapshots
 * are no-ops; we just return the counts so the cycle returns useful info.
 */
import type { Engine } from "../engine/interface.ts";

export interface SnapshotResult {
  documents: number;
  chunks: number;
  embeddings: number;
  entities: number;
  entity_mentions: number;
  capturedAt: string;
  persisted: boolean;
}

export async function snapshotPhase(
  engine: Engine,
): Promise<SnapshotResult> {
  const r = await engine.query<{
    documents: number;
    chunks: number;
    embeddings: number;
    entities: number;
    entity_mentions: number;
  }>(
    `SELECT (SELECT COUNT(*) FROM documents)::int       AS documents,
            (SELECT COUNT(*) FROM chunks)::int          AS chunks,
            (SELECT COUNT(*) FROM embeddings)::int      AS embeddings,
            (SELECT COUNT(*) FROM entities)::int        AS entities,
            (SELECT COUNT(*) FROM entity_mentions)::int AS entity_mentions`,
  );
  const counts = r.rows[0] ?? {
    documents: 0,
    chunks: 0,
    embeddings: 0,
    entities: 0,
    entity_mentions: 0,
  };
  const capturedAt = new Date().toISOString();

  // If the snapshots table exists (created by a future migration), append.
  // We probe via to_regclass which both PGLite and Postgres honour.
  const exists = await engine.query<{ regclass: string | null }>(
    `SELECT to_regclass('cycle_snapshots')::text AS regclass`,
  );
  let persisted = false;
  if (exists.rows[0]?.regclass) {
    await engine.query(
      `INSERT INTO cycle_snapshots
       (captured_at, documents, chunks, embeddings, entities, entity_mentions)
       VALUES ($1::timestamptz, $2, $3, $4, $5, $6)`,
      [
        capturedAt,
        counts.documents,
        counts.chunks,
        counts.embeddings,
        counts.entities,
        counts.entity_mentions,
      ],
    );
    persisted = true;
  }

  return {
    ...counts,
    capturedAt,
    persisted,
  };
}
