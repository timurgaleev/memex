/**
 * Per-document dedup. After RRF the top-k can have multiple chunks from
 * the same document. For a hybrid search UX we usually want one hit
 * per doc (highest-scoring chunk wins) so the user sees a diverse set.
 *
 * Caller may keep all chunks if a query is "show me everything about
 * this exact note" — pass `enabled: false`.
 */

export interface ChunkScore<T = unknown> {
  chunkId: string;
  documentId: string;
  score: number;
  payload?: T;
}

export interface DedupOptions {
  enabled?: boolean;
  /** How many chunks per doc to keep. Default 1. */
  maxPerDoc?: number;
}

export function dedupByDocument<T>(
  hits: readonly ChunkScore<T>[],
  opts: DedupOptions = {},
): ChunkScore<T>[] {
  if (opts.enabled === false) return [...hits];
  const cap = opts.maxPerDoc ?? 1;
  const counts = new Map<string, number>();
  const out: ChunkScore<T>[] = [];
  for (const h of hits) {
    const c = counts.get(h.documentId) ?? 0;
    if (c < cap) {
      out.push(h);
      counts.set(h.documentId, c + 1);
    }
  }
  return out;
}
