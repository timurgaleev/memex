/**
 * Search telemetry — per-day (date, mode, intent) rollup writer + reader
 * (migration 089), the observability substrate behind `memex search
 * stats|tune`.
 *
 * Reference-faithful architecture: a per-process in-memory bucket map,
 * flushed every 60 s OR 100 calls (whichever first) by an unref'd timer.
 * `record()` is sync — the search hot path never waits on the write — and
 * every DB failure is swallowed (telemetry must never break retrieval).
 * Short-lived CLI processes may lose their last bucket by design: stats are
 * directional, not a ledger; the long-lived serve process is the main writer.
 *
 * Rows store SUMS + COUNTS only; the reader derives averages, so concurrent
 * ON CONFLICT adds from several processes accumulate correctly.
 *
 * rank-1 drift adaptation: the reference bands the top hit's calibrated 0..1
 * cosine base_score. memex's fused score is RRF-based (rank math, not a
 * similarity), so the three bands key off the top hit's EVIDENCE class
 * instead — high = exact_title_match / high_vector_match / alias_hit,
 * solid = keyword_exact, lt_solid = weak_semantic (or unclassified) — while
 * sum_rank1_score still accumulates the raw fused score as a directional
 * drift signal within a fixed corpus.
 */
import type { Engine } from "../engine/interface.ts";
import type { Evidence } from "./evidence.ts";

export interface SearchTelemetryMeta {
  /** Active search mode (conservative/balanced/tokenmax). */
  mode: string;
  /** Resolved intent for the call. */
  intent: string;
  /** Query-cache outcome: hit / miss / off (cache bypassed or disabled). */
  cache: "hit" | "miss" | "off";
}

/** Minimal hit shape the recorder needs — SearchHit satisfies it. */
export interface TelemetryHit {
  content: string;
  score: number;
  evidence?: Evidence;
}

interface Bucket {
  date: string;
  mode: string;
  intent: string;
  count: number;
  sum_results: number;
  sum_tokens: number;
  sum_budget_dropped: number;
  cache_hit: number;
  cache_miss: number;
  sum_rank1_score: number;
  count_rank1: number;
  rank1_lt_solid: number;
  rank1_solid: number;
  rank1_high: number;
}

const FLUSH_INTERVAL_MS = 60_000;
const FLUSH_THRESHOLD_CALLS = 100;

const HIGH_EVIDENCE: ReadonlySet<Evidence> = new Set([
  "exact_title_match",
  "high_vector_match",
  "alias_hit",
]);

function nowDate(): string {
  return new Date().toISOString().slice(0, 10);
}

class TelemetryWriter {
  private buckets = new Map<string, Bucket>();
  private pendingCount = 0;
  private engine: Engine | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushInFlight: Promise<void> | null = null;

  setEngine(engine: Engine): void {
    if (!this.engine) {
      this.engine = engine;
      this.ensureTimer();
    }
  }

  record(meta: SearchTelemetryMeta, hits: readonly TelemetryHit[], budgetDropped = 0): void {
    const date = nowDate();
    const key = `${date}::${meta.mode}::${meta.intent}`;
    let b = this.buckets.get(key);
    if (!b) {
      b = {
        date,
        mode: meta.mode,
        intent: meta.intent,
        count: 0,
        sum_results: 0,
        sum_tokens: 0,
        sum_budget_dropped: 0,
        cache_hit: 0,
        cache_miss: 0,
        sum_rank1_score: 0,
        count_rank1: 0,
        rank1_lt_solid: 0,
        rank1_solid: 0,
        rank1_high: 0,
      };
      this.buckets.set(key, b);
    }

    b.count += 1;
    b.sum_results += hits.length;
    // char/4 token heuristic over the returned content (reference parity).
    let chars = 0;
    for (const h of hits) chars += h.content.length;
    b.sum_tokens += Math.floor(chars / 4);
    b.sum_budget_dropped += Math.max(0, Math.floor(budgetDropped));
    if (meta.cache === "hit") b.cache_hit += 1;
    if (meta.cache === "miss") b.cache_miss += 1;

    const top = hits[0];
    if (top && Number.isFinite(top.score)) {
      b.sum_rank1_score += top.score;
      b.count_rank1 += 1;
      if (top.evidence && HIGH_EVIDENCE.has(top.evidence)) b.rank1_high += 1;
      else if (top.evidence === "keyword_exact") b.rank1_solid += 1;
      else b.rank1_lt_solid += 1;
    }

    this.pendingCount += 1;
    if (this.pendingCount >= FLUSH_THRESHOLD_CALLS) {
      void this.flush().catch(() => {});
    }
  }

  /**
   * Drain the bucket map. Concurrent flushes coalesce; the map is swapped
   * before the writes so records landing mid-flush go into a fresh map.
   */
  async flush(): Promise<void> {
    if (this.flushInFlight) return this.flushInFlight;
    if (!this.engine || this.buckets.size === 0) {
      this.pendingCount = 0;
      return;
    }
    const snapshot = this.buckets;
    this.buckets = new Map();
    this.pendingCount = 0;
    const engine = this.engine;
    this.flushInFlight = (async () => {
      try {
        for (const b of snapshot.values()) {
          try {
            await engine.query(
              `INSERT INTO search_telemetry
                 (date, mode, intent, count, sum_results, sum_tokens, sum_budget_dropped,
                  cache_hit, cache_miss, sum_rank1_score, count_rank1,
                  rank1_lt_solid, rank1_solid, rank1_high, first_seen, last_seen)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW(), NOW())
               ON CONFLICT (date, mode, intent) DO UPDATE SET
                 count = search_telemetry.count + EXCLUDED.count,
                 sum_results = search_telemetry.sum_results + EXCLUDED.sum_results,
                 sum_tokens = search_telemetry.sum_tokens + EXCLUDED.sum_tokens,
                 sum_budget_dropped = search_telemetry.sum_budget_dropped + EXCLUDED.sum_budget_dropped,
                 cache_hit = search_telemetry.cache_hit + EXCLUDED.cache_hit,
                 cache_miss = search_telemetry.cache_miss + EXCLUDED.cache_miss,
                 sum_rank1_score = search_telemetry.sum_rank1_score + EXCLUDED.sum_rank1_score,
                 count_rank1 = search_telemetry.count_rank1 + EXCLUDED.count_rank1,
                 rank1_lt_solid = search_telemetry.rank1_lt_solid + EXCLUDED.rank1_lt_solid,
                 rank1_solid = search_telemetry.rank1_solid + EXCLUDED.rank1_solid,
                 rank1_high = search_telemetry.rank1_high + EXCLUDED.rank1_high,
                 last_seen = NOW()`,
              [
                b.date,
                b.mode,
                b.intent,
                b.count,
                b.sum_results,
                b.sum_tokens,
                b.sum_budget_dropped,
                b.cache_hit,
                b.cache_miss,
                b.sum_rank1_score,
                b.count_rank1,
                b.rank1_lt_solid,
                b.rank1_solid,
                b.rank1_high,
              ],
            );
          } catch {
            // Per-bucket isolation — one bad row never loses the others.
          }
        }
      } finally {
        this.flushInFlight = null;
      }
    })();
    return this.flushInFlight;
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.buckets.clear();
    this.pendingCount = 0;
  }

  bucketCountForTest(): number {
    return this.buckets.size;
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.flush().catch(() => {});
    }, FLUSH_INTERVAL_MS);
    // Never keep the process alive for telemetry.
    if (typeof this.timer.unref === "function") this.timer.unref();
  }
}

let _writer: TelemetryWriter | null = null;

export function getTelemetryWriter(): TelemetryWriter {
  if (!_writer) _writer = new TelemetryWriter();
  return _writer;
}

/** Hot-path entry point. Wires the engine lazily; never throws. */
export function recordSearchTelemetry(
  engine: Engine,
  meta: SearchTelemetryMeta,
  hits: readonly TelemetryHit[],
  budgetDropped = 0,
): void {
  try {
    const w = getTelemetryWriter();
    w.setEngine(engine);
    w.record(meta, hits, budgetDropped);
  } catch {
    // best-effort
  }
}

/** Test-only — reset the module singleton between cases. */
export function _resetTelemetryWriterForTest(): void {
  if (_writer) {
    _writer.stop();
    _writer = null;
  }
}

export interface StatsWindow {
  total_calls: number;
  cache_hits: number;
  cache_misses: number;
  cache_hit_rate: number;
  avg_results: number;
  avg_tokens: number;
  total_budget_dropped: number;
  intent_distribution: Record<string, number>;
  mode_distribution: Record<string, number>;
  window_days: number;
  oldest_seen?: string;
  newest_seen?: string;
  avg_rank1_score: number | null;
  rank1_count: number;
  rank1_distribution: { lt_solid: number; solid: number; high: number };
}

/** Aggregate the rollup over a trailing window; averages derived at read time. */
export async function readSearchStats(
  engine: Engine,
  opts: { days?: number } = {},
): Promise<StatsWindow> {
  const days = Math.max(1, Math.min(365, opts.days ?? 7));
  const cutoffDate = new Date(Date.now() - days * 86_400_000)
    .toISOString()
    .slice(0, 10);
  try {
    const { rows } = await engine.query<{
      mode: string;
      intent: string;
      count: number;
      sum_results: number;
      sum_tokens: number;
      sum_budget_dropped: number;
      cache_hit: number;
      cache_miss: number;
      sum_rank1_score: number;
      count_rank1: number;
      rank1_lt_solid: number;
      rank1_solid: number;
      rank1_high: number;
      first_seen: string;
      last_seen: string;
    }>(
      `SELECT mode, intent,
              SUM(count)::int                            AS count,
              SUM(sum_results)::int                      AS sum_results,
              SUM(sum_tokens)::int                       AS sum_tokens,
              SUM(sum_budget_dropped)::int               AS sum_budget_dropped,
              SUM(cache_hit)::int                        AS cache_hit,
              SUM(cache_miss)::int                       AS cache_miss,
              COALESCE(SUM(sum_rank1_score), 0)::float8  AS sum_rank1_score,
              COALESCE(SUM(count_rank1), 0)::int         AS count_rank1,
              COALESCE(SUM(rank1_lt_solid), 0)::int      AS rank1_lt_solid,
              COALESCE(SUM(rank1_solid), 0)::int         AS rank1_solid,
              COALESCE(SUM(rank1_high), 0)::int          AS rank1_high,
              MIN(first_seen)::text                      AS first_seen,
              MAX(last_seen)::text                       AS last_seen
         FROM search_telemetry
        WHERE date >= $1
        GROUP BY mode, intent`,
      [cutoffDate],
    );

    let total_calls = 0;
    let cache_hits = 0;
    let cache_misses = 0;
    let total_results = 0;
    let total_tokens = 0;
    let total_budget_dropped = 0;
    const intent_distribution: Record<string, number> = {};
    const mode_distribution: Record<string, number> = {};
    let oldest_seen: string | undefined;
    let newest_seen: string | undefined;
    let sum_rank1 = 0;
    let count_rank1 = 0;
    let r1_lt = 0;
    let r1_solid = 0;
    let r1_high = 0;

    for (const r of rows) {
      total_calls += r.count;
      cache_hits += r.cache_hit;
      cache_misses += r.cache_miss;
      total_results += r.sum_results;
      total_tokens += r.sum_tokens;
      total_budget_dropped += r.sum_budget_dropped;
      sum_rank1 += r.sum_rank1_score;
      count_rank1 += r.count_rank1;
      r1_lt += r.rank1_lt_solid;
      r1_solid += r.rank1_solid;
      r1_high += r.rank1_high;
      intent_distribution[r.intent] = (intent_distribution[r.intent] ?? 0) + r.count;
      mode_distribution[r.mode] = (mode_distribution[r.mode] ?? 0) + r.count;
      if (r.first_seen && (!oldest_seen || r.first_seen < oldest_seen)) oldest_seen = r.first_seen;
      if (r.last_seen && (!newest_seen || r.last_seen > newest_seen)) newest_seen = r.last_seen;
    }

    const probeTotal = cache_hits + cache_misses;
    const out: StatsWindow = {
      total_calls,
      cache_hits,
      cache_misses,
      cache_hit_rate: probeTotal > 0 ? cache_hits / probeTotal : 0,
      avg_results: total_calls > 0 ? total_results / total_calls : 0,
      avg_tokens: total_calls > 0 ? total_tokens / total_calls : 0,
      total_budget_dropped,
      intent_distribution,
      mode_distribution,
      window_days: days,
      avg_rank1_score: count_rank1 > 0 ? sum_rank1 / count_rank1 : null,
      rank1_count: count_rank1,
      rank1_distribution: { lt_solid: r1_lt, solid: r1_solid, high: r1_high },
    };
    if (oldest_seen !== undefined) out.oldest_seen = oldest_seen;
    if (newest_seen !== undefined) out.newest_seen = newest_seen;
    return out;
  } catch {
    // Table missing / query failed — empty stats beat a thrown dashboard.
    return {
      total_calls: 0,
      cache_hits: 0,
      cache_misses: 0,
      cache_hit_rate: 0,
      avg_results: 0,
      avg_tokens: 0,
      total_budget_dropped: 0,
      intent_distribution: {},
      mode_distribution: {},
      window_days: days,
      avg_rank1_score: null,
      rank1_count: 0,
      rank1_distribution: { lt_solid: 0, solid: 0, high: 0 },
    };
  }
}
