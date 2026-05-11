/**
 * Hybrid search orchestrator — coordinates the pieces in core/search/*.
 *
 * Pipeline:
 *   1. classify intent (Nova Lite, opt-in cache via heuristics)
 *   2. (parallel) embed query → vector retrieval; keyword retrieval
 *   3. (optional) query expansion → extra keyword passes
 *   4. RRF fuse all retrieval lists
 *   5. hydrate top-(k * 3) chunks with parent doc + source kind
 *   6. apply source-boost
 *   7. dedup per documentId (skipped for `exact` intent)
 *   8. (opt-in) two-pass Haiku rerank if MEMEX_RERANK=1
 *   9. trim to k
 *
 * The exported `hybridSearch(storage, query, k)` API stays compatible
 * with existing callers (commands/search.ts, http/search_route.ts,
 * mcp/dispatch.ts). Internal rewiring only.
 */
import type { Storage } from "../storage.ts";
import type { SourceKind } from "../sources.ts";
import { embedText } from "../embedding.ts";
import { reciprocalRankFusion } from "../rrf.ts";
import { vectorSearch } from "./vector.ts";
import { keywordSearch } from "./keyword.ts";
import { dedupByDocument, type ChunkScore } from "./dedup.ts";
import {
  applySourceBoost,
  type BoostablePayload,
} from "./source-boost.ts";
import { classifyIntent, type Intent } from "./intent.ts";
import { expandQuery } from "./expansion.ts";
import { rerank, type ChunkPayloadForRerank } from "./two-pass.ts";

export interface SearchOptions {
  k?: number;
  embeddingModel?: string;
  rrfK?: number;
  /** Restrict to specific sources by id. */
  sourceIds?: readonly string[];
  /** Override MEMEX_RERANK. */
  rerank?: boolean;
  /** Override Nova Lite intent classification — for tests / cheap fallback. */
  intent?: Intent;
  /** Skip query expansion. */
  noExpansion?: boolean;
  /**
   * Optional side-channel: invoked once after results are computed,
   * with the raw query + result IDs + latency + meta. Used by the
   * eval-capture wiring in dispatchers; never blocks user-visible
   * output (callback is awaited but errors are swallowed by the
   * caller).
   */
  onCapture?: (info: SearchCaptureInfo) => Promise<void> | void;
}

export interface SearchCaptureInfo {
  query: string;
  k: number;
  resultDocIds: string[];
  intent: Intent;
  latencyMs: number;
  rerank: boolean;
  expansion: boolean;
}

export interface SearchHit {
  chunkId: string;
  documentId: string;
  sourcePath: string;
  title: string | null;
  content: string;
  score: number;
  intent: Intent;
}

const EMBED_MODEL = "amazon.titan-embed-text-v2:0";

interface HitPayload extends BoostablePayload, ChunkPayloadForRerank {
  /* boostable + rerank-able combined */
}

export async function hybridSearch(
  storage: Storage,
  query: string,
  optsOrK: SearchOptions | number = {},
): Promise<SearchHit[]> {
  const opts: SearchOptions =
    typeof optsOrK === "number" ? { k: optsOrK } : optsOrK;
  const trimmed = (query ?? "").trim();
  if (!trimmed) {
    throw new Error("hybridSearch: query must be non-empty");
  }
  const startedAt = Date.now();
  const k = opts.k ?? 10;
  const fanout = Math.max(20, k * 3);
  const engine = storage.engine();

  // 1. Intent (cheap heuristic + Nova Lite). Allow override for tests.
  const intent = opts.intent ?? (await classifyIntent(trimmed));

  // 2. Embed + parallel retrieval. Keyword needs the original query;
  //    expansion produces additional keyword passes.
  const queryVector = await embedText(trimmed, {
    modelId: opts.embeddingModel ?? EMBED_MODEL,
  });

  const [vectorIds, primaryKeywordIds] = await Promise.all([
    vectorSearch(engine, queryVector, fanout, {
      sourceIds: opts.sourceIds,
    }),
    keywordSearch(engine, trimmed, fanout, {
      sourceIds: opts.sourceIds,
    }),
  ]);

  // 3. Expansion (skip for exact intent or when caller opted out).
  const lists: string[][] = [vectorIds, primaryKeywordIds];
  if (intent !== "exact" && !opts.noExpansion) {
    const variants = await expandQuery(trimmed, { max: 3 });
    if (variants.length > 0) {
      const extra = await Promise.all(
        variants.map((v) =>
          keywordSearch(engine, v, fanout, { sourceIds: opts.sourceIds }),
        ),
      );
      lists.push(...extra);
    }
  }

  // 4. RRF fuse.
  const fused = reciprocalRankFusion(lists, { k: opts.rrfK }).slice(0, fanout);
  if (fused.length === 0) return [];

  // 5. Hydrate.
  const ids = fused.map((f) => f.id);
  const rows = await engine.query<{
    id: string;
    document_id: string;
    content: string;
    source_path: string;
    title: string | null;
    source_id: string | null;
    source_kind: SourceKind | null;
  }>(
    `SELECT c.id, c.document_id, c.content,
            d.source_path, d.title,
            d.source_id,
            s.kind AS source_kind
     FROM chunks c
     JOIN documents d ON d.id = c.document_id
     LEFT JOIN sources s ON s.id = d.source_id
     WHERE c.id = ANY($1::text[])`,
    [ids],
  );
  const byId = new Map(rows.rows.map((r) => [r.id, r]));

  let scored: ChunkScore<HitPayload>[] = [];
  for (const f of fused) {
    const row = byId.get(f.id);
    if (!row) continue;
    scored.push({
      chunkId: row.id,
      documentId: row.document_id,
      score: f.score,
      payload: {
        content: row.content,
        title: row.title,
        sourcePath: row.source_path,
        source_id: row.source_id,
        source_kind: row.source_kind,
      },
    });
  }

  // 6. Source-boost.
  scored = applySourceBoost(scored);

  // Re-sort after boost (RRF was already sorted but boosts may flip).
  scored.sort((a, b) => b.score - a.score);

  // 7. Dedup per doc — skip for `exact` intent.
  const deduped =
    intent === "exact"
      ? scored
      : dedupByDocument(scored, { enabled: true, maxPerDoc: 1 });

  // 8. Two-pass rerank (opt-in).
  const rerankOn =
    opts.rerank ?? process.env.MEMEX_RERANK === "1";
  const final = rerankOn
    ? await rerank(trimmed, deduped.slice(0, k * 2))
    : deduped;

  // 9. Trim.
  const hits: SearchHit[] = final.slice(0, k).map((h) => ({
    chunkId: h.chunkId,
    documentId: h.documentId,
    sourcePath: h.payload?.sourcePath ?? "",
    title: h.payload?.title ?? null,
    content: h.payload?.content ?? "",
    score: h.score,
    intent,
  }));

  // 10. Side-channel: optional capture hook for eval-capture wiring.
  // Errors here never affect the user-visible result — wrapped in a
  // try/catch so a failed INSERT can't poison search.
  if (opts.onCapture) {
    try {
      await opts.onCapture({
        query: trimmed,
        k,
        resultDocIds: hits.map((h) => h.documentId),
        intent,
        latencyMs: Date.now() - startedAt,
        rerank: rerankOn,
        expansion: intent !== "exact" && !opts.noExpansion,
      });
    } catch {
      // Capture failures must not surface; classifier in eval-capture
      // already categorises them for the caller's logging.
    }
  }

  return hits;
}
