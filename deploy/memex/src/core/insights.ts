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
import { hybridSearch, type SearchHit, type SearchOptions } from "./search/hybrid.ts";
import { PAGE_MIRROR_PATH_SQL, isPageSourcePath } from "./page-index.ts";

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

/**
 * Normalise an optional caller-supplied tenant filter. `undefined`/empty stays
 * unscoped (back-compat: every legacy caller reads the whole brain); a non-empty
 * list is deduped to a clean `string[]` ready to bind as `$n::text[]`.
 */
function normalizeSourceIds(sourceIds: string[] | undefined): string[] | undefined {
  if (!Array.isArray(sourceIds) || sourceIds.length === 0) return undefined;
  const cleaned = sourceIds.filter((s) => typeof s === "string" && s.length > 0);
  return cleaned.length > 0 ? Array.from(new Set(cleaned)) : undefined;
}

// --- find_orphans ----------------------------------------------------------

export interface FindOrphansOptions {
  /** Restrict to a single page `type` (e.g. "person"). */
  type?: string;
  /** Max rows (1..1000, default 50). */
  limit?: number;
  /**
   * Tenant scope. `undefined`/empty → unscoped (all sources, back-compat).
   * Non-empty → only pages whose `source_id` is in the list.
   */
  sourceIds?: string[];
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
  const sources = normalizeSourceIds(opts.sourceIds);
  let sourceFilter = "";
  if (sources) {
    params.push(sources);
    sourceFilter = ` AND p.source_id = ANY($${params.length}::text[])`;
  }
  params.push(limit);
  const r = await storage.engine().query<OrphanRow>(
    `SELECT p.slug, p.type, p.title, p.updated_at::text AS updated_at
       FROM pages p
       WHERE p.deleted_at IS NULL${typeFilter}${sourceFilter}
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
  /**
   * Tenant scope. `undefined`/empty → unscoped (back-compat). Non-empty →
   * rank only pages in the listed sources, counting only those sources' edges.
   */
  sourceIds?: string[];
  /**
   * Optional topic query. When present (non-empty), switches from the default
   * link-degree hub ranking to expertise ranking: person/company pages scored
   * by how strongly their body relates to the topic, decayed by relationship
   * recency and lifted by salience. Deterministic — no LLM.
   */
  topic?: string;
  /**
   * Test-only injection of the query embedder, threaded into `hybridSearch`
   * so the topic arm runs hermetically without Bedrock. Production leaves this
   * undefined and the real Titan embedder is used.
   */
  embedQuery?: (text: string) => Promise<number[]>;
}

export interface ExpertRow {
  slug: string;
  type: string;
  title: string | null;
  /** Distinct in+out neighbours that resolve to a live page (link-degree mode). */
  degree: number;
  /**
   * Composite expertise score (topic mode only): expertise × recency × salience.
   * Absent in link-degree mode, where `degree` is the ranking key.
   */
  score?: number;
}

// Expertise-ranking constants (topic mode). Mirrors the locked whoknows spec:
// score = expertise × max(floor, recency_decay) × (0.5 + 0.5 × salience).
const EXPERTISE_HALF_LIFE_DAYS = 180; // ~6-month relationship half-life
const EXPERTISE_RECENCY_FLOOR = 0.1; // cold pages stay visible (no multiplicative-zero)
// Default candidate types when no explicit `type` filter is passed — the
// person/company "who knows about X" surface. Any single `type` override wins.
const EXPERT_DEFAULT_TYPES = ["person", "company"];

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
  if (typeof opts.topic === "string" && opts.topic.trim().length > 0) {
    return findExpertsByTopic(storage, opts);
  }
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
  const sources = normalizeSourceIds(opts.sourceIds);
  let edgeSourceFilter = "";
  let pageSourceFilter = "";
  if (sources) {
    params.push(sources);
    const idx = params.length;
    // Count only the tenant's own edges and rank only the tenant's pages.
    edgeSourceFilter = ` WHERE source_id = ANY($${idx}::text[])`;
    pageSourceFilter = ` AND p.source_id = ANY($${idx}::text[])`;
  }
  params.push(limit);
  const r = await storage.engine().query<{
    slug: string;
    type: string;
    title: string | null;
    degree: number | string;
  }>(
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
     SELECT p.slug, p.type, p.title, COALESCE(d.degree, 0) AS degree
       FROM pages p
       LEFT JOIN degrees d ON d.slug = p.slug
       WHERE p.deleted_at IS NULL${typeFilter}${pageSourceFilter}
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

/**
 * Topic-ranked experts — "who in my brain knows about <topic>?". Person/company
 * pages ranked by expertise depth, not raw graph connectivity. Deterministic:
 * the topic signal is memex's own hybrid search over the page → search mirror
 * (`page://<slug>` documents, see page-index.ts), so a page whose body relates
 * to the topic scores high with NO LLM call.
 *
 *   score = expertise × max(floor, recency_decay) × (0.5 + 0.5 × salience)
 *     expertise      = log1p(topic_match)  — sub-linear; one big page can't dominate.
 *     recency_decay  = exp(-days_since_updated / 180), floored at 0.1.
 *     salience       = pages.salience (already 0..1), centered so missing = neutral.
 *
 * Tenant scope is threaded into the search AND the page resolve so a scoped
 * caller never surfaces another source's people. Defaults to person/company
 * candidates; an explicit `type` overrides that.
 */
async function findExpertsByTopic(
  storage: Storage,
  opts: FindExpertsOptions,
): Promise<ExpertRow[]> {
  const topic = (opts.topic ?? "").trim();
  const limit = clampLimit(opts.limit, 5, 200);
  const sources = normalizeSourceIds(opts.sourceIds);

  // 1. Topic match. Widen the candidate pool (×10, floor 50) so a page's best
  //    chunk score survives chunk-grain fan-out before we collapse to pages.
  const innerK = Math.max(limit * 10, 50);
  // Keep the topic signal deterministic + free (the doc contract above): pin the
  // intent so hybridSearch skips its per-query Haiku intent classifier, disable
  // query expansion (another Haiku call), and drop the backlink boost so ranking
  // reflects topic match, not hub popularity.
  const searchOpts: SearchOptions = {
    k: innerK,
    intent: "topic",
    noExpansion: true,
    backlinkBoost: false,
  };
  if (sources) searchOpts.sourceIds = sources;
  if (opts.embedQuery) searchOpts.embedQuery = opts.embedQuery;
  let hits: SearchHit[];
  try {
    hits = await hybridSearch(storage, topic, searchOpts);
  } catch {
    // A search failure (e.g. embed deadline with no keyword hits) yields no
    // experts rather than throwing — the caller asked a question, not a write.
    return [];
  }

  // 2. Collapse chunk hits to one best score per page-mirror document.
  const bestByPath = new Map<string, number>();
  for (const h of hits) {
    if (!isPageSourcePath(h.sourcePath)) continue;
    const prev = bestByPath.get(h.sourcePath);
    if (prev === undefined || h.score > prev) bestByPath.set(h.sourcePath, h.score);
  }
  if (bestByPath.size === 0) return [];

  // 3. Resolve mirror paths back to live person/company pages, tenant-scoped.
  //    Joining on the mirror-path EXPRESSION (not a parse of source_path) is
  //    unambiguous even when a slug itself contains '/'.
  const paths = Array.from(bestByPath.keys());
  const params: unknown[] = [paths];
  let typeFilter: string;
  if (opts.type !== undefined) {
    if (typeof opts.type !== "string" || opts.type.length === 0) {
      throw new Error("findExperts: type must be a non-empty string");
    }
    params.push(opts.type);
    typeFilter = ` AND p.type = $${params.length}`;
  } else {
    params.push(EXPERT_DEFAULT_TYPES);
    typeFilter = ` AND p.type = ANY($${params.length}::text[])`;
  }
  let pageSourceFilter = "";
  if (sources) {
    params.push(sources);
    pageSourceFilter = ` AND p.source_id = ANY($${params.length}::text[])`;
  }
  const rows = await storage.engine().query<{
    slug: string;
    type: string;
    title: string | null;
    salience: number | string;
    updated_at: string;
    mirror_path: string;
  }>(
    `SELECT p.slug, p.type, p.title, p.salience,
            p.updated_at::text AS updated_at,
            ${PAGE_MIRROR_PATH_SQL} AS mirror_path
       FROM pages p
       WHERE p.deleted_at IS NULL${typeFilter}${pageSourceFilter}
         AND ${PAGE_MIRROR_PATH_SQL} = ANY($1::text[])`,
    params,
  );

  // 4. Score each resolved page.
  const now = Date.now();
  const scored: ExpertRow[] = rows.rows.map((row) => {
    const raw = bestByPath.get(row.mirror_path) ?? 0;
    const expertise = Math.log1p(Math.max(0, Number.isFinite(raw) ? raw : 0));

    let recency = EXPERTISE_RECENCY_FLOOR;
    const updatedMs = Date.parse(row.updated_at);
    if (Number.isFinite(updatedMs)) {
      const days = Math.max(0, (now - updatedMs) / 86_400_000);
      recency = Math.max(EXPERTISE_RECENCY_FLOOR, Math.exp(-days / EXPERTISE_HALF_LIFE_DAYS));
    }

    let salience = Number(row.salience);
    if (!Number.isFinite(salience)) salience = 0;
    salience = Math.min(1, Math.max(0, salience));
    const salienceFactor = 0.5 + 0.5 * salience;

    const score = expertise * recency * salienceFactor;
    return {
      slug: row.slug,
      type: row.type,
      title: row.title,
      degree: 0,
      score: Number.isFinite(score) ? score : 0,
    };
  });

  // 5. Rank by score DESC; tie-break on slug for a deterministic order.
  scored.sort((a, b) => {
    const sb = b.score ?? 0;
    const sa = a.score ?? 0;
    if (sb !== sa) return sb - sa;
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
  });
  return scored.slice(0, limit);
}

// --- find_contradictions ---------------------------------------------------

export interface FindContradictionsOptions {
  /** Substring filter; matches either side of the pair (case-insensitive). */
  slug?: string;
  /** Max rows (1..200, default 20). */
  limit?: number;
  /**
   * Tenant scope. `undefined`/empty → unscoped (back-compat). Non-empty →
   * only `contradicts` edges whose `source_id` is in the list.
   */
  sourceIds?: string[];
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
  const sources = normalizeSourceIds(opts.sourceIds);
  let sourceFilter = "";
  if (sources) {
    params.push(sources);
    sourceFilter = ` AND l.source_id = ANY($${params.length}::text[])`;
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
       WHERE l.type = 'contradicts'${slugFilter}${sourceFilter}
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

// --- probed (suspected) contradictions -------------------------------------

export interface ProbedContradictionRow {
  a_ref: string;
  a_text: string;
  b_ref: string;
  b_text: string;
  severity: string;
  axis: string;
  confidence: number;
  resolution_command: string;
  generated_at: string;
}

/**
 * LLM-suspected contradictions cached by the `probe-contradictions` phase
 * (migration 064) — the paid complement to the asserted `contradicts` edges
 * findContradictions reads. Highest severity + confidence first. Tenant-scoped
 * fail-closed when a read scope is supplied (a NULL/foreign source_id row is
 * excluded, matching migration 047). Fail-open to [] on a pre-064 brain.
 */
export async function listProbedContradictions(
  storage: Storage,
  opts: { limit?: number; sourceIds?: string[] } = {},
): Promise<ProbedContradictionRow[]> {
  const limit = clampLimit(opts.limit, 20, 200);
  const params: unknown[] = [];
  const sources = normalizeSourceIds(opts.sourceIds);
  let sourceFilter = "";
  if (sources) {
    params.push(sources);
    sourceFilter = ` AND source_id = ANY($${params.length}::text[])`;
  }
  params.push(limit);
  try {
    const r = await storage.engine().query<ProbedContradictionRow>(
      `SELECT a_ref, a_text, b_ref, b_text, severity, axis,
              confidence, resolution_command, generated_at::text AS generated_at
         FROM synth_contradictions
        WHERE 1 = 1${sourceFilter}
        ORDER BY
          CASE severity WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END DESC,
          confidence DESC,
          generated_at DESC
        LIMIT $${params.length}`,
      params,
    );
    return r.rows.map((row) => ({
      a_ref: row.a_ref,
      a_text: row.a_text,
      b_ref: row.b_ref,
      b_text: row.b_text,
      severity: row.severity,
      axis: row.axis,
      confidence: Number(row.confidence) || 0,
      resolution_command: row.resolution_command,
      generated_at: row.generated_at,
    }));
  } catch {
    return []; // pre-064 brain — synth_contradictions doesn't exist yet
  }
}

// --- find_trajectory -------------------------------------------------------

export interface FindTrajectoryOptions {
  /** Lower bound (ISO timestamp) on the point's effective date. */
  since?: string;
  /** Upper bound (ISO timestamp). */
  until?: string;
  /** Max points (1..500, default 100). */
  limit?: number;
  /**
   * Tenant scope. `undefined`/empty → unscoped (back-compat). Non-empty →
   * only facts/events whose `source_id` is in the list.
   */
  sourceIds?: string[];
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
  const sources = normalizeSourceIds(opts.sourceIds);
  if (sources) {
    params.push(sources);
    const idx = params.length;
    factBounds += ` AND f.source_id = ANY($${idx}::text[])`;
    eventBounds += ` AND ev.source_id = ANY($${idx}::text[])`;
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
