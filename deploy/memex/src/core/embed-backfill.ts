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
 * Provenance auto-invalidation (migration 066, OPT-IN): when
 * `reembedOnSignatureChange` (env `MEMEX_REEMBED_ON_SIGNATURE_CHANGE=1`) is set,
 * any embedding whose stored `embedding_signature` differs from the CURRENT one
 * (a model or dimension swap) is deleted before candidate selection so it
 * re-embeds this same run. A NULL signature (legacy, pre-066 rows) is treated
 * as "unknown" and never touched, so enabling this never forces a full re-embed
 * of the existing corpus — only rows written with a now-stale signature are
 * re-embedded. It is opt-in, not default: a stray `--model` on a routine
 * backfill must never silently wipe the vector arm; the operator turns it on
 * deliberately for a model swap.
 *
 * Concurrency: embeds run through a bounded worker pool (default 8, config
 * `MEMEX_EMBED_CONCURRENCY`) so a full backfill is ~pool-size faster than the
 * old strictly-sequential loop. Titan has no batch API, so each call is still
 * one InvokeModel — the pool just keeps N in flight at once, with 429 /
 * throttle backoff so a burst never aborts the run. Behaviour-neutral: same
 * rows, same idempotent `ON CONFLICT (chunk_id) DO NOTHING` insert.
 *
 * Idempotent: a chunk that already has an embeddings row is never a candidate,
 * and the INSERT is `ON CONFLICT (chunk_id) DO NOTHING`, so a re-run after a
 * partial pass only embeds what is still missing. A per-chunk embed failure is
 * caught and counted, never aborting the whole run — one bad row or a transient
 * Bedrock error does not strand the rest.
 *
 * Memory + resumability: candidates are NOT loaded in one query. The run walks
 * them keyset-paginated by `chunk_id` (`WHERE c.id COLLATE "C" > $cursor ORDER
 * BY c.id COLLATE "C" LIMIT pageSize`), embedding one page at a time, so a
 * multi-million-chunk backfill has a peak footprint of one page, not the whole
 * missing set. The keyset cursor only ever moves forward by id, and every page
 * still filters `em.chunk_id IS NULL`, so rows embedded earlier this run (all
 * with id <= cursor) never reappear — safe under the concurrent per-page
 * inserts. `result.lastId` returns the last processed id; a caller can pass it
 * back as `startAfterId` to RESUME a capped or interrupted run from where it
 * stopped, and the `IS NULL` predicate makes a plain re-run resumable too.
 */
import type { Engine } from "./engine/interface.ts";
import { embedText, DEFAULT_MODEL_ID, embeddingSignature } from "./embedding.ts";
import { embedSkipFilterFragment } from "./embed-skip.ts";
import { bumpDocumentClock } from "./generation.ts";
import { clearCache } from "./search/query-cache.ts";

/** Default in-flight embed calls when `MEMEX_EMBED_CONCURRENCY` is unset. */
const DEFAULT_CONCURRENCY = 8;
/** Default keyset page size — chunks pulled from the DB per round-trip. */
const DEFAULT_PAGE_SIZE = 500;
/** Max retries for a throttled (429) embed call before it counts as failed. */
const MAX_THROTTLE_RETRIES = 5;
/** Base backoff (ms) for the first throttle retry; doubles each attempt. */
const THROTTLE_BASE_DELAY_MS = 250;

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
  /**
   * Max concurrent embed calls. Default `MEMEX_EMBED_CONCURRENCY` or 8. Clamped
   * to at least 1 (0/negative/garbage → 1, i.e. sequential).
   */
  concurrency?: number;
  /**
   * When set, delete embeddings whose stored signature differs from the current
   * one before selecting candidates, so a model/dim swap re-embeds this run.
   * Default `MEMEX_REEMBED_ON_SIGNATURE_CHANGE=1`, else off. Opt-in by design
   * (see module docs) — never fires on a routine backfill.
   */
  reembedOnSignatureChange?: boolean;
  /**
   * Keyset page size — chunks loaded per DB round-trip. Default 500. Bounds
   * peak memory: the run never materializes the whole candidate set, only one
   * page at a time. Clamped to at least 1.
   */
  pageSize?: number;
  /**
   * Resume cursor: only consider chunks whose id sorts strictly after this one
   * (`c.id COLLATE "C" > startAfterId`). Pass a prior run's `result.lastId` to
   * continue a capped or interrupted backfill from where it stopped. Default:
   * from the start of the id order.
   */
  startAfterId?: string;
}

export interface EmbedBackfillResult {
  /** Non-code chunks missing an embedding (capped by `limit`). */
  candidates: number;
  /** Rows successfully embedded + inserted. */
  embedded: number;
  /** Rows whose embed call threw (skipped, not fatal). */
  failed: number;
  /**
   * Embeddings deleted because their stored signature differed from the current
   * one (migration 066). In a dry run this is the count that WOULD be deleted.
   */
  signatureStale: number;
  dryRun: boolean;
  /**
   * Last chunk id processed this run — the keyset cursor to resume from. Pass
   * it back as `startAfterId` to continue a capped/interrupted backfill. null
   * when no candidate was processed (dry run, or nothing left to embed).
   */
  lastId: string | null;
}

interface CandidateRow {
  id: string;
  content: string;
}

/**
 * The candidate predicate (a boolean SQL expression, no leading `AND`): a
 * non-code, non-embed-skip chunk with non-empty content and no embeddings row.
 * When `hasCursor` is set, `$1` bounds the keyset walk to ids after the cursor.
 * Shared verbatim by the count and page-fetch queries so the two never drift.
 */
function candidateWhere(hasCursor: boolean): string {
  return `em.chunk_id IS NULL
        AND COALESCE(d.frontmatter->>'kind','') <> 'code'
        AND ${embedSkipFilterFragment("d")}
        AND length(btrim(c.content)) > 0${
          hasCursor ? `\n        AND c.id COLLATE "C" > $1` : ""
        }`;
}

/**
 * One keyset page of candidates after `cursor` (exclusive), id-ordered under
 * the same `COLLATE "C"` the cursor comparison uses. At most `pageLimit` rows.
 */
async function fetchCandidatePage(
  engine: Engine,
  cursor: string | undefined,
  pageLimit: number,
): Promise<CandidateRow[]> {
  const params = cursor !== undefined ? [cursor] : [];
  const r = await engine.query<CandidateRow>(
    `SELECT c.id, c.content
       FROM chunks c
       JOIN documents d ON d.id = c.document_id
       LEFT JOIN embeddings em ON em.chunk_id = c.id
      WHERE ${candidateWhere(cursor !== undefined)}
      ORDER BY c.id COLLATE "C" ASC
      LIMIT ${Math.max(1, Math.floor(pageLimit))}`,
    params,
  );
  return r.rows;
}

/**
 * Count candidates (after `cursor`), capped by `limit` — a cheap index-only
 * pass that never materializes the rows, used for the dry-run total and the
 * progress denominator.
 */
async function countCandidates(
  engine: Engine,
  cursor: string | undefined,
  limit?: number,
): Promise<number> {
  const params = cursor !== undefined ? [cursor] : [];
  const r = await engine.query<{ n: number | string }>(
    `SELECT count(*)::int AS n
       FROM chunks c
       JOIN documents d ON d.id = c.document_id
       LEFT JOIN embeddings em ON em.chunk_id = c.id
      WHERE ${candidateWhere(cursor !== undefined)}`,
    params,
  );
  const raw = r.rows[0]?.n;
  const n = typeof raw === "number" ? raw : Number(raw) || 0;
  return limit !== undefined && limit > 0 ? Math.min(n, Math.floor(limit)) : n;
}

/**
 * The embeddable-chunk universe whose stored signature is stale (non-NULL and
 * different from the current one). Scoped to exactly the chunks `findCandidates`
 * would re-embed (non-code, not embed-skipped), so a deleted row is always
 * re-embeddable this run and never stranded without a vector. Legacy NULL
 * signatures are excluded — they are never auto-invalidated.
 */
function staleSignatureSelector(currentSig: string): { where: string; params: [string] } {
  const where = `em.chunk_id IN (
      SELECT c.id
        FROM chunks c
        JOIN documents d ON d.id = c.document_id
       WHERE COALESCE(d.frontmatter->>'kind','') <> 'code'
         AND ${embedSkipFilterFragment("d")}
    )
    AND em.embedding_signature IS NOT NULL
    AND em.embedding_signature <> $1`;
  return { where, params: [currentSig] };
}

/** Count embeddable embeddings whose stored signature is stale. */
async function countStaleSignatures(engine: Engine, currentSig: string): Promise<number> {
  const { where, params } = staleSignatureSelector(currentSig);
  const r = await engine.query<{ n: number | string }>(
    `SELECT count(*)::int AS n FROM embeddings em WHERE ${where}`,
    params,
  );
  const n = r.rows[0]?.n;
  return typeof n === "number" ? n : Number(n) || 0;
}

/**
 * Delete embeddable embeddings whose stored signature is stale so they re-embed
 * this run. Returns the number removed. NULL (legacy) signatures are left
 * untouched — see module docs.
 */
async function invalidateStaleSignatures(engine: Engine, currentSig: string): Promise<number> {
  const { where, params } = staleSignatureSelector(currentSig);
  const r = await engine.query<{ n: number | string }>(
    `WITH d AS (
       DELETE FROM embeddings em WHERE ${where} RETURNING 1
     ) SELECT count(*)::int AS n FROM d`,
    params,
  );
  const n = r.rows[0]?.n;
  return typeof n === "number" ? n : Number(n) || 0;
}

/** True for a Bedrock throttling / 429 error worth retrying with backoff. */
function isThrottle(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const name = (err as { name?: unknown }).name;
  if (name === "ThrottlingException" || name === "TooManyRequestsException") return true;
  const status = (err as { $metadata?: { httpStatusCode?: unknown } }).$metadata?.httpStatusCode;
  return status === 429;
}

/**
 * Embed with bounded exponential backoff on throttle (429) errors only. A
 * non-throttle error rethrows immediately (the caller counts it as failed);
 * throttles retry up to `MAX_THROTTLE_RETRIES` with jittered backoff.
 */
async function embedWithRetry(
  embed: (text: string) => Promise<number[]>,
  text: string,
): Promise<number[]> {
  let attempt = 0;
  for (;;) {
    try {
      return await embed(text);
    } catch (err) {
      if (!isThrottle(err) || attempt >= MAX_THROTTLE_RETRIES) throw err;
      const delay = THROTTLE_BASE_DELAY_MS * 2 ** attempt + Math.floor(Math.random() * 100);
      attempt++;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

/** Resolve the worker-pool width: option wins, else env, else default; min 1. */
function resolveConcurrency(opt?: number): number {
  const raw = opt ?? Number(process.env.MEMEX_EMBED_CONCURRENCY);
  const n = Number.isFinite(raw) ? Math.floor(raw as number) : DEFAULT_CONCURRENCY;
  return n >= 1 ? n : 1;
}

/** Resolve the keyset page size: option wins, else default; min 1. */
function resolvePageSize(opt?: number): number {
  const n = Number.isFinite(opt) ? Math.floor(opt as number) : DEFAULT_PAGE_SIZE;
  return n >= 1 ? n : 1;
}

/**
 * Embed one keyset page through the bounded worker pool. Each real insert calls
 * `onEmbedded`, each per-chunk failure `onFailed`; neither aborts the page (one
 * bad row never strands the rest). Mirrors the prior single-pass pool, now
 * scoped to a page so peak memory stays at one page.
 */
async function embedPage(
  engine: Engine,
  page: CandidateRow[],
  model: string,
  embed: (text: string) => Promise<number[]>,
  concurrency: number,
  onEmbedded: () => void,
  onFailed: () => void,
): Promise<void> {
  let next = 0;
  const total = page.length;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= total) return;
      const row = page[i]!;
      try {
        const vec = await embedWithRetry(embed, row.content);
        const ins = await engine.query<{ chunk_id: string }>(
          `INSERT INTO embeddings (chunk_id, vector, model, embedding_signature)
           VALUES ($1, $2::vector, $3, $4)
           ON CONFLICT (chunk_id) DO NOTHING
           RETURNING chunk_id`,
          [row.id, JSON.stringify(vec), model, embeddingSignature(model, vec.length)],
        );
        // Count only a REAL insert: a concurrent indexer may have written the
        // row first, in which case ON CONFLICT no-ops and we added nothing.
        if (ins.rows.length > 0) onEmbedded();
      } catch (err) {
        onFailed();
        console.error(
          `embed-backfill: chunk ${row.id} failed:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  };
  const pool = Array.from({ length: Math.min(concurrency, total) }, () => worker());
  await Promise.all(pool);
}

export async function runEmbedBackfill(
  engine: Engine,
  opts: EmbedBackfillOptions = {},
): Promise<EmbedBackfillResult> {
  // Record the same model id the embedder actually uses, so a backfilled row's
  // recorded model matches the embedder that produced it (no drift).
  const model = opts.model ?? DEFAULT_MODEL_ID;
  const embed = opts.embed ?? ((t: string) => embedText(t, { modelId: model }));
  const currentSig = embeddingSignature(model);
  const batch = opts.batch && opts.batch > 0 ? opts.batch : 50;
  const concurrency = resolveConcurrency(opts.concurrency);
  const pageSize = resolvePageSize(opts.pageSize);
  const reembedOnSig =
    opts.reembedOnSignatureChange ??
    process.env.MEMEX_REEMBED_ON_SIGNATURE_CHANGE === "1";

  // Provenance auto-invalidation (migration 066), opt-in. Count always (so a
  // dry run reports it); delete only on a real run so the freed rows become
  // candidates below.
  let signatureStale = 0;
  if (reembedOnSig) {
    signatureStale = opts.dryRun
      ? await countStaleSignatures(engine, currentSig)
      : await invalidateStaleSignatures(engine, currentSig);
  }

  // Total up front via a cheap count (index-only, no rows materialized). Used
  // for the dry-run result and as the progress denominator.
  const total = await countCandidates(engine, opts.startAfterId, opts.limit);

  if (opts.dryRun) {
    return { candidates: total, embedded: 0, failed: 0, signatureStale, dryRun: true, lastId: null };
  }

  let embedded = 0;
  let failed = 0;
  let processed = 0;
  let cursor = opts.startAfterId;
  let lastId: string | null = null;

  const onEmbedded = (): void => {
    embedded++;
    if (opts.onProgress && embedded % batch === 0) opts.onProgress(embedded, total);
  };
  const onFailed = (): void => {
    failed++;
  };

  // Keyset walk: one page at a time, advancing the cursor by the last id seen.
  // The cap (`opts.limit`) bounds the total rows processed across pages; the
  // `em.chunk_id IS NULL` predicate + forward-only cursor keep it re-entrant.
  for (;;) {
    if (opts.limit !== undefined && opts.limit > 0 && processed >= opts.limit) break;
    const remaining =
      opts.limit !== undefined && opts.limit > 0 ? opts.limit - processed : undefined;
    const pageLimit = remaining !== undefined ? Math.min(pageSize, remaining) : pageSize;

    const page = await fetchCandidatePage(engine, cursor, pageLimit);
    if (page.length === 0) break;

    await embedPage(engine, page, model, embed, concurrency, onEmbedded, onFailed);

    processed += page.length;
    cursor = page[page.length - 1]!.id;
    lastId = cursor;

    // A short page means the candidate set is exhausted — no further round-trip.
    if (page.length < pageLimit) break;
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
  // signal other observers read. Fire when vectors were inserted OR a stale
  // signature swap deleted rows (both change what the vector arm returns).
  if (embedded > 0 || signatureStale > 0) {
    await bumpDocumentClock(engine);
    await clearCache(engine);
  }

  return { candidates: processed, embedded, failed, signatureStale, dryRun: false, lastId };
}
