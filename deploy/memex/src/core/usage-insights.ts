/**
 * Usage insights — deterministic, LLM-free "what matters / what's odd" reads
 * over the live `pages` graph. Two surfaces:
 *
 *   1. {@link getRecentSalience} — pages ranked by the migration-036 `salience`
 *      score (high-emotion tags + graph link-degree, recomputed by the
 *      `recompute-salience` cycle phase). The MCP read behind `get_recent_salience`;
 *      mirrors the `memex salience` CLI query but as a reusable, storage-only fn.
 *
 *   2. {@link findAnomalies} — deterministic usage OUTLIERS. memex has no
 *      retrieval/access counters (no `last_retrieved` / `retrieval_count`
 *      column on `pages` — verified against migrations 015/024/036), so this
 *      CANNOT key on retrieval-pattern deviation the way a usage-logged brain
 *      would. Instead it surfaces two structural anomaly classes derived from
 *      the signals memex DOES have — `salience` (036) and graph link-degree
 *      (the `links` table):
 *        - `degree_outlier`  — a connectivity hub: link-degree at/above
 *          mean + k·stddev across live pages (k = MEMEX_ANOMALY_SIGMA, default 2).
 *        - `stale_salient`   — a high-salience page (top `salience` band) whose
 *          `updated_at` is older than `staleDays` — important memory going cold.
 *      Both are deterministic: same graph in → same outliers out. No LLM.
 *
 * Read-only. Never mutates. Slugs/titles ARE returned, so the MCP tools wrap
 * these in the public-read redaction policy (see FORBIDDEN_MCP_TOOLS_FROM_PUBLIC).
 */
import type { Storage } from "./storage.ts";

export interface RecentSalienceOptions {
  /** Filter to a single page `type` (exact match). */
  type?: string;
  /** Only pages whose `updated_at` is within the last N days. 0/undefined = all-time. */
  days?: number;
  /** Max rows. Default 20, clamped to [1, 200]. */
  limit?: number;
  /**
   * Tenant scope. `undefined`/empty → unscoped (all sources, back-compat).
   * Non-empty → only pages whose `source_id` is in the list.
   */
  sourceIds?: string[];
}

export interface SalientPage {
  slug: string;
  type: string;
  title: string | null;
  /** [0..1] deterministic importance score (migration 036). */
  salience: number;
  updated_at: string;
}

interface SalienceQueryRow {
  slug: string;
  type: string;
  title: string | null;
  salience: number | string;
  updated_at: string;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;

function clampLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(raw)));
}

/**
 * Normalise an optional caller-supplied tenant filter. `undefined`/empty stays
 * unscoped; a non-empty list is deduped to a clean `string[]` for `$n::text[]`.
 */
function normalizeSourceIds(sourceIds: string[] | undefined): string[] | undefined {
  if (!Array.isArray(sourceIds) || sourceIds.length === 0) return undefined;
  const cleaned = sourceIds.filter((s) => typeof s === "string" && s.length > 0);
  return cleaned.length > 0 ? Array.from(new Set(cleaned)) : undefined;
}

/**
 * Live pages ranked by `salience DESC, updated_at DESC` — the "what matters"
 * read. Honours an optional `type` filter and an `updated_at` recency window.
 */
export async function getRecentSalience(
  storage: Storage,
  opts: RecentSalienceOptions = {},
): Promise<SalientPage[]> {
  const limit = clampLimit(opts.limit);
  const where: string[] = ["deleted_at IS NULL"];
  const params: unknown[] = [];
  if (opts.type !== undefined && opts.type.length > 0) {
    params.push(opts.type);
    where.push(`type = $${params.length}`);
  }
  if (opts.days !== undefined && opts.days > 0) {
    params.push(opts.days);
    where.push(`updated_at >= NOW() - ($${params.length} || ' days')::interval`);
  }
  const sources = normalizeSourceIds(opts.sourceIds);
  if (sources) {
    params.push(sources);
    where.push(`source_id = ANY($${params.length}::text[])`);
  }
  params.push(limit);
  const limitParam = `$${params.length}`;

  const res = await storage.engine().query<SalienceQueryRow>(
    `SELECT slug, type, title, salience, updated_at::text AS updated_at
       FROM pages
       WHERE ${where.join(" AND ")}
       ORDER BY salience DESC, updated_at DESC
       LIMIT ${limitParam}`,
    params,
  );

  return res.rows.map((r) => ({
    slug: r.slug,
    type: r.type,
    title: r.title,
    salience: Number(r.salience) || 0,
    updated_at: r.updated_at,
  }));
}

export type AnomalyKind = "degree_outlier" | "stale_salient";

export interface FindAnomaliesOptions {
  /** Std-devs above the mean degree to flag a connectivity hub. Default 2. */
  sigma?: number;
  /**
   * Days an updated_at must lag to count a high-salience page as stale.
   * Default 90. 0/undefined still uses the default (staleness needs a window).
   */
  staleDays?: number;
  /**
   * `salience` floor for the `stale_salient` class — only pages at/above this
   * band are "important enough" to be worth flagging when cold. Default 0.5
   * (the per-half ceiling in salience-score.ts: a page over 0.5 already has a
   * full tag boost OR strong connectivity). Clamped to [0, 1].
   */
  salienceFloor?: number;
  /** Max rows PER anomaly kind. Default 20, clamped to [1, 200]. */
  limit?: number;
  /**
   * Tenant scope. `undefined`/empty → unscoped (back-compat). Non-empty →
   * consider only the listed sources' pages and count only their edges.
   */
  sourceIds?: string[];
}

export interface Anomaly {
  kind: AnomalyKind;
  slug: string;
  type: string;
  title: string | null;
  salience: number;
  /** Distinct in+out graph neighbours (live pages only). */
  degree: number;
  updated_at: string;
  /**
   * Why this row is an outlier, deterministic:
   *  - degree_outlier: standard-score of `degree` vs the live-page mean/stddev.
   *  - stale_salient:  whole days since `updated_at`.
   */
  metric: number;
}

interface AnomalyQueryRow {
  slug: string;
  type: string;
  title: string | null;
  salience: number | string;
  degree: number | string;
  updated_at: string;
  age_days: number | string;
}

const DEFAULT_SIGMA = 2;
const DEFAULT_STALE_DAYS = 90;
const DEFAULT_SALIENCE_FLOOR = 0.5;

function parseFloatEnv(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Deterministic structural outliers over the live page graph. Computes each
 * page's link-degree (same gated in+out-neighbour count the salience phase
 * uses) and its `updated_at` age in one pass, then flags:
 *   - degree hubs (degree >= mean + sigma·stddev), highest standard-score first;
 *   - stale-but-salient pages (salience >= floor AND age >= staleDays), oldest first.
 *
 * Returns at most `limit` rows of EACH kind. Empty when the graph is too small
 * for a stddev (< 2 pages) or nothing crosses the thresholds.
 */
export async function findAnomalies(
  storage: Storage,
  opts: FindAnomaliesOptions = {},
): Promise<Anomaly[]> {
  const sigma =
    opts.sigma !== undefined && Number.isFinite(opts.sigma) && opts.sigma >= 0
      ? opts.sigma
      : parseFloatEnv(process.env["MEMEX_ANOMALY_SIGMA"]) ?? DEFAULT_SIGMA;
  const staleDays =
    opts.staleDays !== undefined && opts.staleDays > 0
      ? Math.floor(opts.staleDays)
      : DEFAULT_STALE_DAYS;
  const salienceFloor = Math.min(
    1,
    Math.max(
      0,
      opts.salienceFloor !== undefined && Number.isFinite(opts.salienceFloor)
        ? opts.salienceFloor
        : DEFAULT_SALIENCE_FLOOR,
    ),
  );
  const limit = clampLimit(opts.limit);

  const sources = normalizeSourceIds(opts.sourceIds);
  const params: unknown[] = [];
  let edgeSourceFilter = "";
  let pageSourceFilter = "";
  if (sources) {
    params.push(sources);
    edgeSourceFilter = ` WHERE source_id = ANY($1::text[])`;
    pageSourceFilter = ` AND p.source_id = ANY($1::text[])`;
  }

  // Degree = distinct in+out neighbours per slug, gated to live target pages —
  // identical to recompute-salience so the two views never disagree on degree.
  const res = await storage.engine().query<AnomalyQueryRow>(
    `WITH edges AS (
       SELECT source_slug AS slug, target_slug AS neighbour FROM links${edgeSourceFilter}
       UNION ALL
       SELECT target_slug AS slug, source_slug AS neighbour FROM links${edgeSourceFilter}
     ),
     degrees AS (
       SELECT e.slug, COUNT(DISTINCT e.neighbour) AS degree
       FROM edges e
       JOIN pages np ON np.slug = e.neighbour AND np.deleted_at IS NULL
       GROUP BY e.slug
     )
     SELECT p.slug,
            p.type,
            p.title,
            p.salience,
            COALESCE(d.degree, 0) AS degree,
            p.updated_at::text AS updated_at,
            EXTRACT(EPOCH FROM (NOW() - p.updated_at)) / 86400 AS age_days
       FROM pages p
       LEFT JOIN degrees d ON d.slug = p.slug
       WHERE p.deleted_at IS NULL${pageSourceFilter}`,
    params,
  );

  const rows = res.rows.map((r) => ({
    slug: r.slug,
    type: r.type,
    title: r.title,
    salience: Number(r.salience) || 0,
    degree: Number(r.degree) || 0,
    updated_at: r.updated_at,
    ageDays: Math.floor(Number(r.age_days) || 0),
  }));

  const degreeOutliers = detectDegreeOutliers(rows, sigma, limit);
  const staleSalient = detectStaleSalient(rows, salienceFloor, staleDays, limit);
  return [...degreeOutliers, ...staleSalient];
}

interface PageStat {
  slug: string;
  type: string;
  title: string | null;
  salience: number;
  degree: number;
  updated_at: string;
  ageDays: number;
}

/** Connectivity hubs: degree >= mean + sigma·stddev, highest z-score first. */
function detectDegreeOutliers(
  rows: readonly PageStat[],
  sigma: number,
  limit: number,
): Anomaly[] {
  if (rows.length < 2) return [];
  const degrees = rows.map((r) => r.degree);
  const mean = degrees.reduce((a, b) => a + b, 0) / degrees.length;
  const variance =
    degrees.reduce((a, d) => a + (d - mean) * (d - mean), 0) / degrees.length;
  const stddev = Math.sqrt(variance);
  // A flat graph (every page same degree) has no outliers — guard div-by-zero.
  if (stddev === 0) return [];
  const cutoff = mean + sigma * stddev;
  return rows
    .filter((r) => r.degree >= cutoff && r.degree > 0)
    .map((r) => ({
      kind: "degree_outlier" as const,
      slug: r.slug,
      type: r.type,
      title: r.title,
      salience: r.salience,
      degree: r.degree,
      updated_at: r.updated_at,
      metric: (r.degree - mean) / stddev,
    }))
    .sort((a, b) => b.metric - a.metric || a.slug.localeCompare(b.slug))
    .slice(0, limit);
}

/** High-salience pages gone cold: salience >= floor AND age >= staleDays. */
function detectStaleSalient(
  rows: readonly PageStat[],
  salienceFloor: number,
  staleDays: number,
  limit: number,
): Anomaly[] {
  return rows
    .filter((r) => r.salience >= salienceFloor && r.ageDays >= staleDays)
    .map((r) => ({
      kind: "stale_salient" as const,
      slug: r.slug,
      type: r.type,
      title: r.title,
      salience: r.salience,
      degree: r.degree,
      updated_at: r.updated_at,
      metric: r.ageDays,
    }))
    .sort((a, b) => b.metric - a.metric || a.slug.localeCompare(b.slug))
    .slice(0, limit);
}
