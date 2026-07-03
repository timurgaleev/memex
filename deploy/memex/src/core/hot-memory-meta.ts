/**
 * `_meta.brain_hot_memory` MCP injection helper (mirrors the reference's
 * getBrainHotMemoryMeta, adapted to memex's `hot_memory` table, migration 020).
 *
 * The `hot_memory` inbox (recent, unvetted observations the brain just heard)
 * has no MCP surface today. This helper lets the dispatcher attach a decay-
 * weighted top-K slice of it as best-effort `_meta` on a tool-call response, so
 * a connected agent gets "what the brain is currently holding in short-term
 * memory" for free alongside its actual result.
 *
 * SAFETY (why this is opt-in + internal-only):
 *   - `hot_memory` carries NO source_id / visibility axis and holds raw
 *     free-text PII (see the security note in core/hot_memory.ts). It must never
 *     cross the public ingress, so the dispatcher gates this to
 *     non-public calls AND the payload is empty unless MEMEX_HOT_MEMORY_META=1.
 *   - Best-effort: the dispatcher wraps this in try/catch and NEVER fails a tool
 *     call on an error here. This module still aims to fail cleanly.
 *   - Short TTL cache so a burst of tool calls costs one query, not N.
 */
import type { Storage } from "./storage.ts";
import { listRecentHotFacts, type HotFactRow } from "./hot_memory.ts";

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_TOP_K = 10;
const MAX_TOP_K = 25;
/** Confidence half-life: a fact's decay weight halves every this-many hours. */
const DECAY_HALF_LIFE_HOURS = 24;
/** Facts older than this (hours) are never surfaced regardless of confidence. */
const MAX_AGE_HOURS = 72;

interface CacheEntry {
  expiresAt: number;
  payload: Record<string, unknown> | undefined;
}

const _cache = new Map<string, CacheEntry>();

/**
 * Feature gate. Default OFF — the injection surfaces unvetted PII, so it stays
 * dark until an operator opts in with MEMEX_HOT_MEMORY_META=1.
 */
export function hotMemoryMetaEnabled(
  env: string | undefined = process.env["MEMEX_HOT_MEMORY_META"],
): boolean {
  return env === "1";
}

/** Decay-weighted score for a hot fact: confidence × 0.5^(ageHours/halfLife). */
function decayScore(row: HotFactRow, now: number): number {
  const written = Date.parse(row.written_at);
  const ageHours = Number.isFinite(written)
    ? Math.max(0, (now - written) / 3_600_000)
    : 0;
  const decay = Math.pow(0.5, ageHours / DECAY_HALF_LIFE_HOURS);
  return row.effective_confidence * decay;
}

/**
 * Build the `_meta.brain_hot_memory` payload, or undefined when there is
 * nothing to inject (disabled, no recent facts). Cached for a short TTL.
 *
 * The caller is responsible for the public/tenant gate — this returns raw hot
 * facts and must only be invoked on an internal (non-public) tool call.
 */
export async function getBrainHotMemoryMeta(
  storage: Storage,
  opts: { topK?: number; ttlMs?: number; now?: number } = {},
): Promise<Record<string, unknown> | undefined> {
  if (!hotMemoryMetaEnabled()) return undefined;
  const now = opts.now ?? Date.now();
  const ttl = Math.max(1000, opts.ttlMs ?? DEFAULT_TTL_MS);
  const topK = Math.max(1, Math.min(opts.topK ?? DEFAULT_TOP_K, MAX_TOP_K));
  const cacheKey = `k${topK}`;

  const cached = _cache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.payload;

  const since = new Date(now - MAX_AGE_HOURS * 3_600_000).toISOString();
  // Over-fetch a little so decay re-ordering has candidates beyond the raw
  // newest-N, then cut to top-K by decayed score.
  const rows = await listRecentHotFacts(storage, { limit: topK * 3, since });
  if (rows.length === 0) {
    _cache.set(cacheKey, { expiresAt: now + ttl, payload: undefined });
    return undefined;
  }

  const ranked = rows
    .map((r) => ({ row: r, score: decayScore(r, now) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  const payload = {
    brain_hot_memory: {
      facts: ranked.map(({ row, score }) => ({
        id: row.id,
        entity_slug: row.entity_slug,
        fact: row.fact,
        written_at: row.written_at,
        confidence: Number(score.toFixed(3)),
      })),
    },
  };
  _cache.set(cacheKey, { expiresAt: now + ttl, payload });
  return payload;
}

/** Test helper: clear the TTL cache. */
export function __resetHotMemoryMetaCacheForTests(): void {
  _cache.clear();
}
