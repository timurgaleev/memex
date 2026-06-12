/**
 * Embedding backfill — (re)embed non-code chunks that are missing an
 * `embeddings` row.
 *
 * The markdown indexer embeds every chunk it writes, but a brain can still
 * accumulate non-code chunks with NO embedding: rows indexed before embedding
 * was wired, a dropped embedding-dimension migration, or transient Bedrock
 * failures mid-index. Those chunks are invisible to the VECTOR arm of hybrid
 * search — only the keyword arm can reach them — so a real retrieval hole
 * opens silently. This walks the missing chunks and computes their Titan
 * vectors so the vector arm sees the whole corpus again.
 *
 * Code chunks are graph-only by design (no embeddings) and are excluded: the
 * candidate set matches `source-health`'s `embeddable` definition (document
 * frontmatter `kind` <> 'code').
 *
 * Idempotent: a chunk that already has an embeddings row is never a candidate,
 * and the INSERT is `ON CONFLICT (chunk_id) DO NOTHING`, so a re-run after a
 * partial pass only embeds what is still missing. A per-chunk embed failure is
 * caught and counted, never aborting the whole run — one bad row or a transient
 * Bedrock error does not strand the rest.
 */
import type { Engine } from "./engine/interface.ts";
import { embedText, DEFAULT_MODEL_ID } from "./embedding.ts";
import { bumpDocumentClock } from "./generation.ts";
import { clearCache } from "./search/query-cache.ts";

export interface EmbedBackfillOptions {
  /** Max chunks to embed this run. Default: no cap (all candidates). */
  limit?: number;
  /** Count candidates only — never write. */
  dryRun?: boolean;
  /** Embedding model id recorded on each row. */
  model?: string;
  /**
   * Embedder injection seam — tests pass a deterministic fn; production uses
   * the real Titan `embedText`. Mirrors hybrid.ts's `embedQuery` seam.
   */
  embed?: (text: string) => Promise<number[]>;
  /** Progress callback, fired every `batch` successful embeds. */
  onProgress?: (done: number, total: number) => void;
  /** Progress cadence. Default 50. */
  batch?: number;
}

export interface EmbedBackfillResult {
  /** Non-code chunks missing an embedding (capped by `limit`). */
  candidates: number;
  /** Rows successfully embedded + inserted. */
  embedded: number;
  /** Rows whose embed call threw (skipped, not fatal). */
  failed: number;
  dryRun: boolean;
}

interface CandidateRow {
  id: string;
  content: string;
}

/** Non-code chunks with no embeddings row and non-empty content, id-ordered. */
async function findCandidates(
  engine: Engine,
  limit?: number,
): Promise<CandidateRow[]> {
  // limit is validated as a positive integer by the caller; floor for safety.
  const limitClause =
    limit !== undefined && limit > 0 ? `LIMIT ${Math.floor(limit)}` : "";
  const r = await engine.query<CandidateRow>(
    `SELECT c.id, c.content
       FROM chunks c
       JOIN documents d ON d.id = c.document_id
       LEFT JOIN embeddings em ON em.chunk_id = c.id
      WHERE em.chunk_id IS NULL
        AND COALESCE(d.frontmatter->>'kind','') <> 'code'
        AND length(btrim(c.content)) > 0
      ORDER BY c.id COLLATE "C" ASC
      ${limitClause}`,
  );
  return r.rows;
}

export async function runEmbedBackfill(
  engine: Engine,
  opts: EmbedBackfillOptions = {},
): Promise<EmbedBackfillResult> {
  const embed = opts.embed ?? ((t: string) => embedText(t));
  // Record the same model id `embedText` defaults to, so a backfilled row's
  // recorded model matches the embedder that produced it (no drift).
  const model = opts.model ?? DEFAULT_MODEL_ID;
  const batch = opts.batch && opts.batch > 0 ? opts.batch : 50;
  const candidates = await findCandidates(engine, opts.limit);

  if (opts.dryRun) {
    return { candidates: candidates.length, embedded: 0, failed: 0, dryRun: true };
  }

  let embedded = 0;
  let failed = 0;
  for (const row of candidates) {
    try {
      const vec = await embed(row.content);
      const ins = await engine.query<{ chunk_id: string }>(
        `INSERT INTO embeddings (chunk_id, vector, model)
         VALUES ($1, $2::vector, $3)
         ON CONFLICT (chunk_id) DO NOTHING
         RETURNING chunk_id`,
        [row.id, JSON.stringify(vec), model],
      );
      // Count only a REAL insert: a concurrent indexer may have written the
      // row first, in which case ON CONFLICT no-ops and we added nothing.
      if (ins.rows.length > 0) {
        embedded++;
        if (opts.onProgress && embedded % batch === 0) {
          opts.onProgress(embedded, candidates.length);
        }
      }
    } catch (err) {
      failed++;
      console.error(
        `embed-backfill: chunk ${row.id} failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // Repairing the vector arm changes what hybrid search returns, so the
  // query cache must be invalidated — otherwise a ranking cached BEFORE the
  // backfill keeps being served, bypassing the freshly-embedded chunks. Under
  // the two-layer cache (migration 031) bumping the global clock is NOT
  // sufficient: backfill adds embeddings WITHOUT bumping any document's
  // `generation`, so a cached row whose referenced docs are unchanged would
  // survive Layer 2 and serve a stale ranking. A full clear is the correct,
  // unambiguous flush for this rare operator-triggered maintenance op (the
  // cache refills organically). The clock bump is kept as the corpus-changed
  // signal other observers read. Both only when vectors were actually inserted.
  if (embedded > 0) {
    await bumpDocumentClock(engine);
    await clearCache(engine);
  }

  return { candidates: candidates.length, embedded, failed, dryRun: false };
}
