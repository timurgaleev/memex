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

/**
 * Near-duplicate dedup by text similarity (Jaccard on word sets) — an additive
 * stage after the per-document dedup. Per-doc dedup keeps the best chunk PER
 * doc, but two DIFFERENT documents can still carry near-identical text (e.g. a
 * note and its `.bak` copy); this drops a hit whose content is too similar to a
 * higher-ranked already-kept hit. Greedy + rank-order-preserving (the first,
 * higher-scored occurrence wins).
 *
 * Adapted from the reference's Layer-2 text-similarity dedup. The reference's
 * other layers are NOT ported: type-diversity needs a page-type taxonomy memex
 * doesn't have, and the compiled-truth guarantee is an LLM-cycle artifact memex
 * doesn't produce.
 */
const DEFAULT_NEARDUP_JACCARD = 0.85;

/**
 * Don't judge a hit as a near-dup unless it has at least this many distinct
 * words. Two short chunks (terse list items, one-line config) can share enough
 * boilerplate to clear a 0.85 Jaccard while being genuinely distinct documents;
 * the floor protects them from a false drop. A hit below the floor is always
 * kept.
 */
const MIN_DEDUP_TOKENS = 12;

interface NearDupPayload {
  content?: string;
}

function wordSet(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/\s+/).filter(Boolean));
}

/** Jaccard similarity of two word sets. Empty-vs-anything is treated as 0 (an
 *  empty/contentless hit can't be judged a near-dup, so it is never dropped). */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

export function dedupByTextSimilarity<T extends NearDupPayload>(
  hits: readonly ChunkScore<T>[],
  threshold: number = DEFAULT_NEARDUP_JACCARD,
): ChunkScore<T>[] {
  const kept: ChunkScore<T>[] = [];
  const keptSets: Set<string>[] = [];
  for (const h of hits) {
    const ws = wordSet(h.payload?.content ?? "");
    let dup = false;
    // Only judge hits with enough words; short hits are never dropped (the
    // floor) so a terse-but-distinct chunk can't be a false near-dup.
    if (ws.size >= MIN_DEDUP_TOKENS) {
      for (const ks of keptSets) {
        if (jaccard(ws, ks) > threshold) {
          dup = true;
          break;
        }
      }
    }
    if (!dup) {
      kept.push(h);
      keptSets.push(ws);
    }
  }
  return kept;
}

/**
 * Near-dup Jaccard threshold, memoized once per process (single source shared
 * by the ranking path AND the query-cache key, so they can't diverge). Env
 * `MEMEX_NEARDUP_JACCARD` overrides the 0.85 default; a value > 1.0 disables the
 * stage (no Jaccard can exceed it). Malformed → throw (fail-loud), matching the
 * other ranking-knob parsers.
 */
export class NearDupThresholdParseError extends Error {}

export function resolveNearDupThreshold(
  envValue: string | undefined = process.env["MEMEX_NEARDUP_JACCARD"],
): number {
  if (envValue === undefined || envValue.trim() === "") return DEFAULT_NEARDUP_JACCARD;
  const raw = envValue.trim();
  if (!/^\d+(\.\d+)?$/.test(raw)) {
    throw new NearDupThresholdParseError(
      `invalid MEMEX_NEARDUP_JACCARD: ${JSON.stringify(envValue)}`,
    );
  }
  const v = Number.parseFloat(raw);
  if (!Number.isFinite(v) || v < 0) {
    throw new NearDupThresholdParseError(
      `invalid MEMEX_NEARDUP_JACCARD: ${JSON.stringify(envValue)}`,
    );
  }
  return v;
}

let _nearDupThreshold: number | null = null;
export function getNearDupThreshold(): number {
  return (_nearDupThreshold ??= resolveNearDupThreshold());
}
