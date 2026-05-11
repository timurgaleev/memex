/**
 * embed-stale — re-embed chunks whose embedding is older than `staleDays`.
 *
 * Walks documents whose embeddings.created_at is below the threshold,
 * reads the source file from disk, calls `indexDocument()` to re-chunk +
 * re-embed via Bedrock Titan v2. File-missing rows are skipped silently;
 * `orphans-purge` will collect them.
 *
 * Originally lived in `recipes/dream.ts`. split it out so each
 * cycle phase is a single-responsibility module.
 */
import { existsSync, readFileSync } from "node:fs";
import type { Engine } from "../engine/interface.ts";
import { Storage } from "../storage.ts";
import { indexDocument } from "../indexer.ts";

export interface EmbedStaleOptions {
  /** Days threshold. Default 30. */
  staleDays?: number;
  /** Hard cap on re-embeds per cycle. Default 50. */
  maxPerCycle?: number;
}

export interface EmbedStaleResult {
  scanned: number;
  reembedded: number;
  errors: { sourcePath: string; message: string }[];
}

interface StaleRow {
  doc_id: string;
  source_path: string;
}

export async function findStale(
  engine: Engine,
  staleDays: number,
  limit: number,
): Promise<StaleRow[]> {
  const r = await engine.query<StaleRow>(
    `SELECT DISTINCT d.id AS doc_id, d.source_path
     FROM documents d
     JOIN chunks c     ON c.document_id = d.id
     JOIN embeddings e ON e.chunk_id = c.id
     WHERE e.created_at < NOW() - ($1 || ' days')::interval
     ORDER BY d.source_path
     LIMIT $2`,
    [String(staleDays), limit],
  );
  return r.rows;
}

export async function embedStalePhase(
  engine: Engine,
  opts: EmbedStaleOptions = {},
): Promise<EmbedStaleResult> {
  const staleDays = opts.staleDays ?? 30;
  const maxPerCycle = opts.maxPerCycle ?? 50;
  const stale = await findStale(engine, staleDays, maxPerCycle);
  const result: EmbedStaleResult = {
    scanned: stale.length,
    reembedded: 0,
    errors: [],
  };

  // indexDocument lives on Storage; wrap engine in one for the phase.
  const storage = new Storage(engine);
  for (const row of stale) {
    if (!existsSync(row.source_path)) continue; // orphans-purge handles
    try {
      const text = readFileSync(row.source_path, "utf8");
      await indexDocument(storage, {
        sourcePath: row.source_path,
        text,
      });
      result.reembedded++;
    } catch (e) {
      result.errors.push({
        sourcePath: row.source_path,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return result;
}
