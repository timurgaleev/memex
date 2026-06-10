/**
 * source-health.ts — brain-level operational health metrics.
 *
 * memex is single-holder / effectively single-source, so these are reported at
 * the brain level rather than per-source (the reference's per-source breakdown
 * collapses to one row here). They answer "is the brain ingesting + embedding
 * its data, and is the job queue healthy?":
 *
 *   - embed_coverage_pct : of the chunks that SHOULD carry a vector (markdown /
 *     non-code — code chunks are graph-only by design, `kind:'code'`), how many
 *     actually have an embeddings row. A low value means the vector arm of
 *     hybrid search can't see those chunks (keyword/FTS still can).
 *   - lag_seconds        : wall-clock staleness = now − newest document update.
 *   - queue_depth        : pending jobs waiting to run.
 *   - failed_jobs_24h    : jobs that FAILED in the last 24h — the one
 *     unambiguous "something broke" signal.
 *
 * Pure read-only aggregation. No Bedrock, no writes. Cheap enough for a doctor
 * probe.
 */
import type { Engine } from "./engine/interface.ts";

export interface BrainHealthMetrics {
  /** Chunks expected to carry a vector (non-code). */
  embeddable_chunks: number;
  /** Of the embeddable chunks, how many have an embeddings row. */
  embedded_chunks: number;
  /** embedded / embeddable, in [0,1]. 1.0 when there is nothing to embed. */
  embed_coverage_pct: number;
  /** Chunks that are graph-only by design (`kind:'code'`) — excluded from coverage. */
  code_chunks: number;
  /** now − newest document update, in seconds. null when no documents. */
  lag_seconds: number | null;
  /** Pending jobs waiting to run. */
  queue_depth: number;
  /** Jobs that failed in the last 24h. */
  failed_jobs_24h: number;
}

function toInt(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function toNumOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Compute the brain-level health metrics in a handful of cheap aggregate
 * queries. Code chunks (`documents.frontmatter->>'kind' = 'code'`) are excluded
 * from the embedding-coverage denominator because they are intentionally
 * graph-only.
 */
export async function brainHealthMetrics(
  engine: Engine,
): Promise<BrainHealthMetrics> {
  // COUNT(DISTINCT c.id): the LEFT JOIN to embeddings is 1:1 today
  // (embeddings.chunk_id is the PK), but DISTINCT keeps the metric correct even
  // if a future schema lets a chunk carry multiple embedding rows — no risk of
  // coverage exceeding 100%.
  const chunkRow = await engine.query<{
    embeddable: number | string;
    embedded: number | string;
    code: number | string;
  }>(
    `SELECT
       COUNT(DISTINCT c.id) FILTER (WHERE COALESCE(d.frontmatter->>'kind','') <> 'code')::int AS embeddable,
       COUNT(DISTINCT c.id) FILTER (
         WHERE COALESCE(d.frontmatter->>'kind','') <> 'code'
           AND em.chunk_id IS NOT NULL
       )::int AS embedded,
       COUNT(DISTINCT c.id) FILTER (WHERE COALESCE(d.frontmatter->>'kind','') = 'code')::int AS code
     FROM chunks c
     JOIN documents d ON d.id = c.document_id
     LEFT JOIN embeddings em ON em.chunk_id = c.id`,
  );
  const embeddable = toInt(chunkRow.rows[0]?.embeddable);
  const embedded = toInt(chunkRow.rows[0]?.embedded);
  const code = toInt(chunkRow.rows[0]?.code);

  const lagRow = await engine.query<{ lag: number | string | null }>(
    `SELECT EXTRACT(EPOCH FROM (NOW() - MAX(updated_at)))::bigint AS lag FROM documents`,
  );
  const lag = toNumOrNull(lagRow.rows[0]?.lag);

  const jobRow = await engine.query<{ queue_depth: number | string; failed_24h: number | string }>(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'pending')::int AS queue_depth,
       COUNT(*) FILTER (
         WHERE status = 'failed'
           AND (finished_at IS NULL OR finished_at >= NOW() - INTERVAL '24 hours')
       )::int AS failed_24h
     FROM jobs`,
  );
  const queueDepth = toInt(jobRow.rows[0]?.queue_depth);
  const failed24h = toInt(jobRow.rows[0]?.failed_24h);

  return {
    embeddable_chunks: embeddable,
    embedded_chunks: embedded,
    embed_coverage_pct: embeddable > 0 ? embedded / embeddable : 1,
    code_chunks: code,
    lag_seconds: lag,
    queue_depth: queueDepth,
    failed_jobs_24h: failed24h,
  };
}
