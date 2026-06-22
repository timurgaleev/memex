/**
 * Graph-insight reads — deterministic, LLM-free hygiene + discovery queries
 * over the page/link/fact/timeline graph. All four answer "shape of the
 * knowledge base" questions a maintainer asks during an enrichment cycle:
 *
 *   - findOrphans       — pages with zero inbound links (enrichment targets).
 *   - findExperts       — pages ranked by graph link-degree (the hubs).
 *   - findContradictions — page pairs joined by an explicit `contradicts` edge.
 *   - findTrajectory    — chronological how-an-entity-changed log, merging the
 *                         entity_facts ledger with timeline_events.
 *
 * Each is a single SQL round-trip with $N placeholders and {rows} reads,
 * mirroring the existing links.ts / facts.ts query style. Soft-deleted pages
 * (`pages.deleted_at IS NOT NULL`) are excluded everywhere a page row is the
 * subject, so a deleted page never appears as an orphan/expert/contradiction.
 *
 * Tables: pages (015), links (016), timeline_events (017), entity_facts (018 +
 * 037 metadata). No schema change — all columns queried already exist.
 */
import type { Storage } from "./storage.ts";

// Shared kebab-case slug grammar (matches links.ts / pages.ts). Validated at
// the boundary so a caller-supplied slug can never be interpolated raw, and a
// malformed value fails fast with a clear message rather than an empty result.
const SLUG_RE = /^[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*$/;
const MAX_SLUG_LEN = 256;

function validateSlug(slug: string): void {
  if (typeof slug !== "string" || slug.length === 0) {
    throw new Error("slug must be a non-empty string");
  }
  if (slug.length > MAX_SLUG_LEN) {
    throw new Error(`slug exceeds ${MAX_SLUG_LEN} chars`);
  }
  if (!SLUG_RE.test(slug)) {
    throw new Error(
      `slug must match kebab-case with optional / namespaces (got ${JSON.stringify(slug)})`,
    );
  }
}

/** Clamp an optional caller limit into [1, max], default `def`. */
function clampLimit(limit: number | undefined, def: number, max: number): number {
  if (typeof limit === "number" && limit >= 1 && limit <= max) {
    return Math.floor(limit);
  }
  return def;
}

// --- find_orphans ----------------------------------------------------------

export interface FindOrphansOptions {
  /** Restrict to a single page `type` (e.g. "person"). */
  type?: string;
  /** Max rows (1..1000, default 50). */
  limit?: number;
}

export interface OrphanRow {
  slug: string;
  type: string;
  title: string | null;
  updated_at: string;
}

/**
 * Pages with zero inbound links — nothing in the graph references them. These
 * are the natural enrichment targets (a page nobody links to is either new or
 * forgotten). Soft-deleted pages are excluded. Newest-first so the freshest
 * unlinked pages surface at the top of an enrichment queue.
 */
export async function findOrphans(
  storage: Storage,
  opts: FindOrphansOptions = {},
): Promise<OrphanRow[]> {
  const limit = clampLimit(opts.limit, 50, 1000);
  const params: unknown[] = [];
  let typeFilter = "";
  if (opts.type !== undefined) {
    if (typeof opts.type !== "string" || opts.type.length === 0) {
      throw new Error("findOrphans: type must be a non-empty string");
    }
    params.push(opts.type);
    typeFilter = ` AND p.type = $${params.length}`;
  }
  params.push(limit);
  const r = await storage.engine().query<OrphanRow>(
    `SELECT p.slug, p.type, p.title, p.updated_at::text AS updated_at
       FROM pages p
       WHERE p.deleted_at IS NULL${typeFilter}
         AND NOT EXISTS (
           SELECT 1 FROM links l WHERE l.target_slug = p.slug
         )
       ORDER BY p.updated_at DESC
       LIMIT $${params.length}`,
    params,
  );
  return r.rows;
}

// --- find_experts ----------------------------------------------------------

export interface FindExpertsOptions {
  /** Restrict to a single page `type`. */
  type?: string;
  /** Max rows (1..200, default 5). */
  limit?: number;
}

export interface ExpertRow {
  slug: string;
  type: string;
  title: string | null;
  /** Distinct in+out neighbours that resolve to a live page. */
  degree: number;
}

/**
 * Pages ranked by graph link-degree — the hubs of the knowledge base. Degree
 * is distinct in+out neighbours, counting ONLY edges to existing, non-deleted
 * pages (same inflation-safe gating as the recompute-salience phase: a page
 * can't rank as an expert by listing many unresolved `[[wikilink]]` stubs).
 * Ties break on updated_at DESC so the ordering is deterministic.
 */
export async function findExperts(
  storage: Storage,
  opts: FindExpertsOptions = {},
): Promise<ExpertRow[]> {
  const limit = clampLimit(opts.limit, 5, 200);
  const params: unknown[] = [];
  let typeFilter = "";
  if (opts.type !== undefined) {
    if (typeof opts.type !== "string" || opts.type.length === 0) {
      throw new Error("findExperts: type must be a non-empty string");
    }
    params.push(opts.type);
    typeFilter = ` AND p.type = $${params.length}`;
  }
  params.push(limit);
  const r = await storage.engine().query<{
    slug: string;
    type: string;
    title: string | null;
    degree: number | string;
  }>(
    `WITH edges AS (
       SELECT source_slug AS slug, target_slug AS neighbour FROM links
       UNION ALL
       SELECT target_slug AS slug, source_slug AS neighbour FROM links
     ),
     degrees AS (
       SELECT e.slug, COUNT(DISTINCT e.neighbour) AS degree
       FROM edges e
       JOIN pages np ON np.slug = e.neighbour AND np.deleted_at IS NULL
       GROUP BY e.slug
     )
     SELECT p.slug, p.type, p.title, COALESCE(d.degree, 0) AS degree
       FROM pages p
       LEFT JOIN degrees d ON d.slug = p.slug
       WHERE p.deleted_at IS NULL${typeFilter}
       ORDER BY COALESCE(d.degree, 0) DESC, p.updated_at DESC, p.slug COLLATE "C" ASC
       LIMIT $${params.length}`,
    params,
  );
  return r.rows.map((row) => ({
    slug: row.slug,
    type: row.type,
    title: row.title,
    degree: Number(row.degree) || 0,
  }));
}

// --- find_contradictions ---------------------------------------------------

export interface FindContradictionsOptions {
  /** Substring filter; matches either side of the pair (case-insensitive). */
  slug?: string;
  /** Max rows (1..200, default 20). */
  limit?: number;
}

export interface ContradictionRow {
  source_slug: string;
  target_slug: string;
  source_title: string | null;
  target_title: string | null;
  confidence: number;
  written_at: string;
}

/**
 * Page pairs joined by an explicit `contradicts` edge (links.type =
 * 'contradicts', migration 016). Deterministic — surfaces the conflict markers
 * already asserted in the graph; it does NOT run a fresh probe or call an LLM.
 * The source side is gated to a live page (FK + deleted_at); the target is a
 * soft reference, so its title is LEFT-joined and may be null when the target
 * page doesn't exist yet.
 */
export async function findContradictions(
  storage: Storage,
  opts: FindContradictionsOptions = {},
): Promise<ContradictionRow[]> {
  const limit = clampLimit(opts.limit, 20, 200);
  const params: unknown[] = [];
  let slugFilter = "";
  if (opts.slug !== undefined) {
    if (typeof opts.slug !== "string" || opts.slug.length === 0) {
      throw new Error("findContradictions: slug must be a non-empty string");
    }
    // Substring match on either side. ILIKE pattern is parameterised; escape
    // the LIKE metacharacters so a literal `%`/`_` in the filter can't widen it.
    const escaped = opts.slug.toLowerCase().replace(/[\\%_]/g, "\\$&");
    params.push(`%${escaped}%`);
    slugFilter = ` AND (l.source_slug ILIKE $${params.length} ESCAPE '\\' OR l.target_slug ILIKE $${params.length} ESCAPE '\\')`;
  }
  params.push(limit);
  const r = await storage.engine().query<ContradictionRow>(
    `SELECT l.source_slug, l.target_slug,
            sp.title AS source_title, tp.title AS target_title,
            l.inferred_confidence AS confidence,
            l.written_at::text AS written_at
       FROM links l
       JOIN pages sp ON sp.slug = l.source_slug AND sp.deleted_at IS NULL
       LEFT JOIN pages tp ON tp.slug = l.target_slug AND tp.deleted_at IS NULL
       WHERE l.type = 'contradicts'${slugFilter}
       ORDER BY l.written_at DESC
       LIMIT $${params.length}`,
    params,
  );
  return r.rows.map((row) => ({
    source_slug: row.source_slug,
    target_slug: row.target_slug,
    source_title: row.source_title,
    target_title: row.target_title,
    confidence: Number(row.confidence) || 0,
    written_at: row.written_at,
  }));
}

// --- find_trajectory -------------------------------------------------------

export interface FindTrajectoryOptions {
  /** Lower bound (ISO timestamp) on the point's effective date. */
  since?: string;
  /** Upper bound (ISO timestamp). */
  until?: string;
  /** Max points (1..500, default 100). */
  limit?: number;
}

export interface TrajectoryPoint {
  /** "fact" (entity_facts ledger) or "event" (timeline_events). */
  source: "fact" | "event";
  /** ISO timestamp the point is anchored at (fact valid_from→written_at fallback; event occurred_at). */
  at: string;
  /** Free-text claim/event description. */
  text: string;
  /** Fact category (mig037 kind) or null for events / legacy facts. */
  kind: string | null;
  /** Underlying row id (entity_facts.id or timeline_events.id). */
  id: number;
}

/**
 * Chronological "how did this entity change?" log for one slug — the merged
 * view of its entity_facts ledger and its timeline_events, oldest-first so a
 * caller reads the entity's history top-to-bottom. Each fact is anchored at its
 * `valid_from` when set (when the claim became true) and falls back to
 * `written_at` (when it was recorded); each event at its `occurred_at`. Bounds
 * filter on that anchor date. No LLM — pure ledger merge.
 */
export async function findTrajectory(
  storage: Storage,
  entitySlug: string,
  opts: FindTrajectoryOptions = {},
): Promise<TrajectoryPoint[]> {
  validateSlug(entitySlug);
  const limit = clampLimit(opts.limit, 100, 500);
  // $1 = entity slug; the bound params are shared across both arms of the UNION.
  const params: unknown[] = [entitySlug];
  let factBounds = "";
  let eventBounds = "";
  if (opts.since !== undefined) {
    if (typeof opts.since !== "string" || opts.since.length === 0) {
      throw new Error("findTrajectory: since must be a non-empty ISO string");
    }
    params.push(opts.since);
    const idx = params.length;
    factBounds += ` AND COALESCE(f.valid_from::timestamptz, f.written_at) >= $${idx}::timestamptz`;
    eventBounds += ` AND ev.occurred_at >= $${idx}::timestamptz`;
  }
  if (opts.until !== undefined) {
    if (typeof opts.until !== "string" || opts.until.length === 0) {
      throw new Error("findTrajectory: until must be a non-empty ISO string");
    }
    params.push(opts.until);
    const idx = params.length;
    factBounds += ` AND COALESCE(f.valid_from::timestamptz, f.written_at) <= $${idx}::timestamptz`;
    eventBounds += ` AND ev.occurred_at <= $${idx}::timestamptz`;
  }
  params.push(limit);
  const limitIdx = params.length;
  const r = await storage.engine().query<{
    source: "fact" | "event";
    at: string;
    text: string;
    kind: string | null;
    id: number | string;
  }>(
    `SELECT * FROM (
       SELECT 'fact'::text AS source,
              COALESCE(f.valid_from::timestamptz, f.written_at)::text AS at,
              f.fact AS text,
              f.kind AS kind,
              f.id AS id
         FROM entity_facts f
         WHERE f.entity_slug = $1${factBounds}
       UNION ALL
       SELECT 'event'::text AS source,
              ev.occurred_at::text AS at,
              ev.event AS text,
              NULL::text AS kind,
              ev.id AS id
         FROM timeline_events ev
         WHERE ev.slug = $1${eventBounds}
     ) merged
     ORDER BY merged.at ASC, merged.source ASC, merged.id ASC
     LIMIT $${limitIdx}`,
    params,
  );
  return r.rows.map((row) => ({
    source: row.source,
    at: row.at,
    text: row.text,
    kind: row.kind,
    id: Number(row.id),
  }));
}
