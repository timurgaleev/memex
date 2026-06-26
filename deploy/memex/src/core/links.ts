/**
 * Links -- page-to-page typed graph CRUD over migration 016_links_typed.
 *
 * Two write paths:
 *   1. Explicit (`addLink` / `removeLink`) -- the agent or a skill is
 *      asserting a typed relationship. Confidence defaults to 1.0.
 *   2. Implicit (`extractWikilinks` + `syncWikilinksForPage`) -- the
 *      deterministic [[wikilink]] scanner derives `type=wikilink`
 *      edges from a page's markdown_body. Idempotent: re-running on
 *      the same body replaces the wikilink edge set for that source
 *      slug, never touching edges of other types.
 *
 * NL-pattern extraction for works_at / attended / founded / ... is a
 * future commit: those patterns need their own test fixture corpus.
 * For now the agent writes those types via the explicit `link` MCP
 * tool.
 */
import type { Storage } from "./storage.ts";
import { makeSlugResolver } from "./slug-canonicalize.ts";

// Catalogue of well-known link types. Not a DB constraint -- extensible
// at runtime. New types may be passed with `allowAdHocType: true`.
export const KNOWN_LINK_TYPES = [
  "wikilink",
  "mentions",
  "works_at",
  "attended",
  "founded",
  "advises",
  "invested_in",
  "knows",
  "met",
  "located_at",
  "related_to",
  "supersedes",
  "contradicts",
] as const;

export type KnownLinkType = (typeof KNOWN_LINK_TYPES)[number];

// Same kebab-case + optional `/` namespaces grammar as pages. Validate
// at the boundary so a future MCP write call can never poison the
// `links.target_slug` column with garbage. Permissive on input ("Alice
// Smith") -- see `slugifyTarget` below -- strict on output.
const SLUG_RE = /^[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*$/;
const MAX_SLUG_LEN = 256;

export function validateSlug(slug: string): void {
  if (typeof slug !== "string" || slug.length === 0) {
    throw new Error("link slug must be a non-empty string");
  }
  if (slug.length > MAX_SLUG_LEN) {
    throw new Error(`link slug exceeds ${MAX_SLUG_LEN} chars`);
  }
  if (!SLUG_RE.test(slug)) {
    throw new Error(
      `link slug must match kebab-case with optional / namespaces ` +
        `(got ${JSON.stringify(slug)})`,
    );
  }
}

/**
 * Loose name -> strict slug. Lowercase, hyphenate whitespace, drop
 * everything not in [a-z0-9/-]. Preserves `/` so namespaced inputs
 * like `people/alice-smith` round-trip identically. Falls back to
 * `unknown` for empty / all-stripped inputs so we never produce an
 * invalid slug.
 */
export function slugifyTarget(name: string): string {
  if (typeof name !== "string") return "unknown";
  const normalised = name
    .toLowerCase()
    // Compose-y unicode (accented letters, ligatures) -> NFKD pieces.
    .normalize("NFKD")
    // Any whitespace (including unicode spaces) becomes a hyphen.
    .replace(/\s+/g, "-")
    // Keep only ASCII a-z, 0-9, hyphen, slash. Drop everything else.
    .replace(/[^a-z0-9/-]/g, "")
    // Collapse repeated hyphens / slashes that resulted from the strip.
    .replace(/-+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/^[-/]+|[-/]+$/g, "")
    .slice(0, MAX_SLUG_LEN);
  return normalised.length > 0 ? normalised : "unknown";
}

function normaliseType(
  type: string | undefined,
  allowAdHoc: boolean | undefined,
): string {
  if (!type || typeof type !== "string") {
    throw new Error("link type is required");
  }
  const t = type.trim().toLowerCase();
  if (!t) throw new Error("link type cannot be blank");
  if (!allowAdHoc && !KNOWN_LINK_TYPES.includes(t as KnownLinkType)) {
    throw new Error(
      `link type ${JSON.stringify(t)} not in KNOWN_LINK_TYPES; ` +
        `pass allowAdHocType: true to accept it`,
    );
  }
  return t;
}

function normaliseConfidence(c: number | undefined): number {
  if (c === undefined) return 1.0;
  if (typeof c !== "number" || Number.isNaN(c)) {
    throw new Error("confidence must be a number in [0, 1]");
  }
  if (c < 0 || c > 1) {
    throw new Error("confidence must be in [0, 1]");
  }
  return c;
}

/** Edge derivation kind — see migration 029. */
export type LinkKind = "plain" | "typed_ner";
/** Wikilink resolution form — see migration 029. */
export type ResolutionType = "qualified" | "unqualified";

export interface LinkRow {
  id: number;
  source_slug: string;
  target_slug: string;
  type: string;
  inferred_confidence: number;
  source_chunk_id: string | null;
  written_at: string;
  // Provenance (migration 029) — populated by enrichment passes, NULL/empty
  // for explicit `link` calls and pre-029 edges. Optional on the type because
  // the graph-read projections (graphNeighbors / graphQuery) deliberately do
  // NOT select them — a partial LinkRow omits them entirely.
  context?: string;
  link_kind?: LinkKind | null;
  origin_slug?: string | null;
  origin_field?: string | null;
  resolution_type?: ResolutionType | null;
}

export interface AddLinkInput {
  source_slug: string;
  target_slug: string;
  type: string;
  confidence?: number;
  source_chunk_id?: string;
  allowAdHocType?: boolean;
  // Provenance (migration 029) — optional; written by enrichment callers,
  // omitted by the explicit `link` MCP tool. On an idempotent re-add these
  // are sticky: an omitted field preserves the previously-stored value.
  context?: string;
  link_kind?: LinkKind;
  origin_slug?: string;
  origin_field?: string;
  resolution_type?: ResolutionType;
  /**
   * Tenant source scope (migration 047). Omitted -> the column DEFAULT
   * 'default' applies, preserving whole-brain behavior.
   */
  source_id?: string;
}

/** Upper bound on the stored mention-context window (defence vs unbounded writes). */
const MAX_CONTEXT_LEN = 4000;
const MAX_ORIGIN_FIELD_LEN = 256;

function normaliseLinkKind(v: string | undefined): LinkKind | null {
  if (v === undefined) return null;
  if (v !== "plain" && v !== "typed_ner") {
    throw new Error(`link_kind must be 'plain' | 'typed_ner' (got ${JSON.stringify(v)})`);
  }
  return v;
}

function normaliseResolutionType(v: string | undefined): ResolutionType | null {
  if (v === undefined) return null;
  if (v !== "qualified" && v !== "unqualified") {
    throw new Error(
      `resolution_type must be 'qualified' | 'unqualified' (got ${JSON.stringify(v)})`,
    );
  }
  return v;
}

export interface AddLinkResult {
  source_slug: string;
  target_slug: string;
  type: string;
  /** True when the (source, target, type) tuple did not exist before. */
  created: boolean;
}

/**
 * Idempotent add. Re-inserting an existing (source, target, type)
 * tuple updates the confidence + chunk_id but doesn't error and
 * doesn't double-count. The UNIQUE index on the tuple guarantees
 * single-row outcome.
 */
export async function addLink(
  storage: Storage,
  input: AddLinkInput,
): Promise<AddLinkResult> {
  validateSlug(input.source_slug);
  const target = slugifyTarget(input.target_slug);
  // After slugify the target should validate; if not the input was
  // pathological (empty after stripping).
  validateSlug(target);
  const type = normaliseType(input.type, input.allowAdHocType);
  const conf = normaliseConfidence(input.confidence);
  const chunkId = input.source_chunk_id ?? null;
  // Provenance (migration 029). Validate at the boundary so a bad caller
  // can't poison the enum/origin columns.
  const context = (input.context ?? "").slice(0, MAX_CONTEXT_LEN);
  const linkKind = normaliseLinkKind(input.link_kind);
  let originSlug: string | null = null;
  if (input.origin_slug !== undefined) {
    validateSlug(input.origin_slug);
    originSlug = input.origin_slug;
  }
  const originField =
    input.origin_field === undefined
      ? null
      : input.origin_field.slice(0, MAX_ORIGIN_FIELD_LEN);
  const resolutionType = normaliseResolutionType(input.resolution_type);
  // Tenant scope (mig047): stamp source_id only when provided so the NOT NULL
  // column's DEFAULT 'default' applies otherwise (never pass NULL).
  const sourceId =
    typeof input.source_id === "string" && input.source_id.length > 0
      ? input.source_id
      : null;
  const sourceCol = sourceId !== null ? ", source_id" : "";
  const sourceVal = sourceId !== null ? ", $11" : "";
  const params: unknown[] = [
    input.source_slug, target, type, conf, chunkId,
    context, linkKind, originSlug, originField, resolutionType,
  ];
  if (sourceId !== null) params.push(sourceId);
  // On an idempotent re-add, provenance is STICKY: an omitted field (empty
  // context / NULL enum) preserves the prior value so a bare `link` re-call
  // never wipes enrichment-written provenance.
  const r = await storage.engine().query<{ inserted: boolean }>(
    `INSERT INTO links
       (source_slug, target_slug, type, inferred_confidence, source_chunk_id,
        context, link_kind, origin_slug, origin_field, resolution_type${sourceCol})
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10${sourceVal})
     ON CONFLICT (source_slug, target_slug, type) DO UPDATE
       SET inferred_confidence = EXCLUDED.inferred_confidence,
           source_chunk_id     = EXCLUDED.source_chunk_id,
           context             = CASE WHEN EXCLUDED.context <> ''
                                      THEN EXCLUDED.context ELSE links.context END,
           link_kind           = COALESCE(EXCLUDED.link_kind, links.link_kind),
           origin_slug         = COALESCE(EXCLUDED.origin_slug, links.origin_slug),
           origin_field        = COALESCE(EXCLUDED.origin_field, links.origin_field),
           resolution_type     = COALESCE(EXCLUDED.resolution_type, links.resolution_type)
     RETURNING (xmax = 0) AS inserted`,
    params,
  );
  return {
    source_slug: input.source_slug,
    target_slug: target,
    type,
    created: r.rows[0]?.inserted ?? false,
  };
}

export interface RemoveLinkInput {
  source_slug: string;
  target_slug: string;
  type: string;
}

export async function removeLink(
  storage: Storage,
  input: RemoveLinkInput,
): Promise<{ removed: number }> {
  validateSlug(input.source_slug);
  const target = slugifyTarget(input.target_slug);
  const type = normaliseType(input.type, true);
  const r = await storage.engine().query<{ removed: number }>(
    `WITH d AS (
       DELETE FROM links
        WHERE source_slug = $1 AND target_slug = $2 AND type = $3
        RETURNING 1
     )
     SELECT COUNT(*)::int AS removed FROM d`,
    [input.source_slug, target, type],
  );
  return { removed: r.rows[0]?.removed ?? 0 };
}

export interface GraphNeighborsOptions {
  type?: string;
  direction?: "outbound" | "inbound" | "both";
  limit?: number;
  /**
   * Tenant source scope (migration 047). When non-empty, edges are filtered
   * to `source_id = ANY(...)`. Omitted/empty -> unscoped (whole-brain).
   */
  sourceIds?: string[];
}

export interface NeighborRow extends LinkRow {
  /** "outbound" -> this slug is the source; "inbound" -> this slug is the target. */
  direction: "outbound" | "inbound";
}

/**
 * Page-centric graph traversal: all links touching `slug` in the
 * given direction (default `both`). Optional `type` filter.
 */
export async function graphNeighbors(
  storage: Storage,
  slug: string,
  opts: GraphNeighborsOptions = {},
): Promise<NeighborRow[]> {
  validateSlug(slug);
  const direction = opts.direction ?? "both";
  if (!["outbound", "inbound", "both"].includes(direction)) {
    throw new Error(
      `graphNeighbors: direction must be outbound|inbound|both (got ${direction})`,
    );
  }
  const type = opts.type ? normaliseType(opts.type, true) : null;
  const limit =
    typeof opts.limit === "number" && opts.limit >= 1 && opts.limit <= 1000
      ? Math.floor(opts.limit)
      : 100;
  const params: unknown[] = [slug];
  let typeFilter = "";
  if (type) {
    params.push(type);
    typeFilter = ` AND type = $${params.length}`;
  }
  // Tenant scope (mig047): same filter string applied to both UNION arms.
  let scopeFilter = "";
  if (opts.sourceIds && opts.sourceIds.length > 0) {
    params.push(opts.sourceIds);
    scopeFilter = ` AND source_id = ANY($${params.length}::text[])`;
  }
  const queries: string[] = [];
  if (direction === "outbound" || direction === "both") {
    queries.push(
      `SELECT id, source_slug, target_slug, type, inferred_confidence,
              source_chunk_id, written_at::text AS written_at,
              'outbound' AS direction
       FROM links
       WHERE source_slug = $1${typeFilter}${scopeFilter}`,
    );
  }
  if (direction === "inbound" || direction === "both") {
    queries.push(
      `SELECT id, source_slug, target_slug, type, inferred_confidence,
              source_chunk_id, written_at::text AS written_at,
              'inbound' AS direction
       FROM links
       WHERE target_slug = $1${typeFilter}${scopeFilter}`,
    );
  }
  params.push(limit);
  const sql = `${queries.join("\nUNION ALL\n")}
    ORDER BY written_at DESC
    LIMIT $${params.length}`;
  const r = await storage.engine().query<NeighborRow>(sql, params);
  return r.rows;
}

export interface GraphQueryOptions {
  type: string;
  source_slug?: string;
  target_slug?: string;
  limit?: number;
  /**
   * Tenant source scope (migration 047). When non-empty, edges are filtered
   * to `source_id = ANY(...)`. Omitted/empty -> unscoped (whole-brain).
   */
  sourceIds?: string[];
}

/**
 * Typed-relationship query. Examples:
 *   { type: "works_at", source_slug: "people/alice" }
 *     -> companies Alice works at
 *   { type: "works_at", target_slug: "companies/acme" }
 *     -> people who work at Acme
 *   { type: "wikilink", source_slug: "journal/2026-05-18" }
 *     -> wikilinks referenced from today's journal entry
 *
 * At least one of `source_slug` / `target_slug` is required so we
 * never accidentally return the entire `links` table.
 */
export async function graphQuery(
  storage: Storage,
  opts: GraphQueryOptions,
): Promise<LinkRow[]> {
  const type = normaliseType(opts.type, true);
  if (!opts.source_slug && !opts.target_slug) {
    throw new Error(
      "graphQuery: at least one of source_slug / target_slug is required",
    );
  }
  const params: unknown[] = [type];
  const where: string[] = [`type = $1`];
  if (opts.source_slug) {
    validateSlug(opts.source_slug);
    params.push(opts.source_slug);
    where.push(`source_slug = $${params.length}`);
  }
  if (opts.target_slug) {
    const target = slugifyTarget(opts.target_slug);
    validateSlug(target);
    params.push(target);
    where.push(`target_slug = $${params.length}`);
  }
  if (opts.sourceIds && opts.sourceIds.length > 0) {
    params.push(opts.sourceIds);
    where.push(`source_id = ANY($${params.length}::text[])`);
  }
  const limit =
    typeof opts.limit === "number" && opts.limit >= 1 && opts.limit <= 1000
      ? Math.floor(opts.limit)
      : 100;
  params.push(limit);
  const r = await storage.engine().query<LinkRow>(
    `SELECT id, source_slug, target_slug, type, inferred_confidence,
            source_chunk_id, written_at::text AS written_at
       FROM links
       WHERE ${where.join(" AND ")}
       ORDER BY inferred_confidence DESC, written_at DESC
       LIMIT $${params.length}`,
    params,
  );
  return r.rows;
}

export interface TraverseGraphOptions {
  /** Max hops from the start (1..10). Default 3. */
  maxDepth?: number;
  /** Edge direction to follow. Default `outbound`. */
  direction?: "outbound" | "inbound" | "both";
  /** Optional edge-type filter. */
  type?: string;
  /** Max distinct nodes returned (1..1000). Default 100. */
  limit?: number;
  /**
   * Tenant source scope (migration 047). When non-empty, only edges with
   * `source_id = ANY(...)` are traversed. Omitted/empty -> unscoped.
   */
  sourceIds?: string[];
}

export interface TraverseHit {
  slug: string;
  /** Shortest hop distance from the start node (>= 1). */
  depth: number;
}

/**
 * Recursive N-hop graph walk from `startSlug` over the `links` edge table —
 * the multi-hop counterpart to single-hop `graphNeighbors`/`graphQuery`.
 * Depth-capped, cycle-safe (a node already on the current path is never
 * re-entered), returns each reachable node once at its shortest depth.
 *
 * `direction` selects which way edges are followed; `both` treats the graph as
 * undirected. Bounded by `maxDepth` AND `limit`. Deterministic, no LLM. The SQL
 * avoids LATERAL for PGLite/Postgres portability.
 */
export async function traverseGraph(
  storage: Storage,
  startSlug: string,
  opts: TraverseGraphOptions = {},
): Promise<TraverseHit[]> {
  validateSlug(startSlug);
  const direction = opts.direction ?? "outbound";
  if (!["outbound", "inbound", "both"].includes(direction)) {
    throw new Error(
      `traverseGraph: direction must be outbound|inbound|both (got ${direction})`,
    );
  }
  const maxDepth =
    typeof opts.maxDepth === "number" && opts.maxDepth >= 1 && opts.maxDepth <= 10
      ? Math.floor(opts.maxDepth)
      : 3;
  const limit =
    typeof opts.limit === "number" && opts.limit >= 1 && opts.limit <= 1000
      ? Math.floor(opts.limit)
      : 100;
  const type = opts.type ? normaliseType(opts.type, true) : null;

  // direction → join condition + the "other end" expression. Whitelisted
  // literals (never user input) — safe to interpolate.
  const joinCond =
    direction === "outbound"
      ? "l.source_slug = w.slug"
      : direction === "inbound"
        ? "l.target_slug = w.slug"
        : "(l.source_slug = w.slug OR l.target_slug = w.slug)";
  const nextExpr =
    direction === "outbound"
      ? "l.target_slug"
      : direction === "inbound"
        ? "l.source_slug"
        : "CASE WHEN l.source_slug = w.slug THEN l.target_slug ELSE l.source_slug END";

  const params: unknown[] = [startSlug, maxDepth];
  let typeFilter = "";
  if (type) {
    params.push(type);
    typeFilter = ` AND l.type = $${params.length}`;
  }
  // Tenant scope (mig047): confine the walk to edges in the given sources.
  let scopeFilter = "";
  if (opts.sourceIds && opts.sourceIds.length > 0) {
    params.push(opts.sourceIds);
    scopeFilter = ` AND l.source_id = ANY($${params.length}::text[])`;
  }
  params.push(limit);
  const limitParam = `$${params.length}`;

  // ponytail: `limit` bounds the OUTPUT (distinct nodes), not the CTE's work —
  // path-based pruning materializes every simple path up to maxDepth, so a
  // DENSE graph at high maxDepth (esp. `both`) can fan out super-linearly
  // before the final GROUP BY. maxDepth (cap 10) is the real cost guard; fine
  // for memex's small, sparse wiki-link graph. If the graph ever grows dense,
  // switch to a per-iteration visited-set cap or lower the `both` ceiling.
  const r = await storage.engine().query<{ slug: string; depth: number }>(
    `WITH RECURSIVE walk(slug, depth, path) AS (
       SELECT $1::text, 0, ARRAY[$1::text]
       UNION ALL
       SELECT ${nextExpr}, w.depth + 1, w.path || ${nextExpr}
       FROM walk w
       JOIN links l ON ${joinCond}
       WHERE w.depth < $2
         AND NOT (${nextExpr} = ANY(w.path))${typeFilter}${scopeFilter}
     )
     SELECT slug, MIN(depth) AS depth
       FROM walk
      WHERE depth > 0
      GROUP BY slug
      ORDER BY MIN(depth) ASC, slug ASC
      LIMIT ${limitParam}`,
    params,
  );
  return r.rows.map((x) => ({ slug: x.slug, depth: Number(x.depth) }));
}

// ---------------------------------------------------------------------------
// Deterministic [[wikilink]] extractor -- zero LLM, idempotent.
// ---------------------------------------------------------------------------

const WIKILINK_RE = /\[\[([^\]\n|]+?)(?:\|[^\]\n]+)?\]\]/g;

/**
 * Extract every distinct [[wikilink]] surface form from a markdown
 * body. Returns the original surface forms (not yet slugified) so
 * callers can keep both raw and normalised values if needed.
 */
export function extractWikilinks(body: string): string[] {
  if (typeof body !== "string" || body.length === 0) return [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  WIKILINK_RE.lastIndex = 0;
  while ((match = WIKILINK_RE.exec(body)) !== null) {
    const raw = match[1]?.trim();
    if (raw && raw.length > 0) seen.add(raw);
  }
  return [...seen];
}

/**
 * Replace the wikilink-typed outbound link set for a given source
 * page with the wikilinks present in `body`. Other-typed links are
 * untouched. Runs in one transaction so a partial extract never
 * leaves the graph in an inconsistent state.
 *
 * Each raw `[[mention]]` is canonicalized to an EXISTING page slug via
 * the 4-stage resolver (core/slug-canonicalize.ts) before the edge is
 * written, so `[[Alice Smith]]` lands on `people/alice-smith` instead of
 * a dangling `alice-smith`. A mention that resolves to a real page is
 * stamped `resolution_type = 'qualified'`; the slugify fallback is
 * `'unqualified'`. Resolution reads pages/links OUTSIDE the write
 * transaction (the targets are other pages, independent of the edge
 * rewrite); the delete + insert stay transactional.
 */
export async function syncWikilinksForPage(
  storage: Storage,
  sourceSlug: string,
  body: string,
  sourceId?: string,
): Promise<{ removed: number; added: number }> {
  validateSlug(sourceSlug);
  // Tenant scope (mig047): stamp source_id on derived edges only when given,
  // else let the column DEFAULT 'default' apply (never pass NULL).
  const scope =
    typeof sourceId === "string" && sourceId.length > 0 ? sourceId : null;

  // Resolve each distinct mention, then collapse to one edge per target
  // slug (two surface forms may canonicalize to the same page). A
  // 'qualified' resolution wins over an 'unqualified' one for the same slug.
  const resolver = makeSlugResolver(storage, sourceSlug);
  const byTarget = new Map<string, boolean>(); // slug -> qualified?
  for (const name of extractWikilinks(body)) {
    const r = await resolver.resolve(name);
    if (r.slug === "unknown") continue;
    // Drop a self-loop: a page linking to itself is graph noise. (The
    // resolver already excludes self from fuzzy/tail/prefix matches; this
    // also catches an explicit `[[own-slug]]` resolved exact/slugify.)
    if (r.slug === sourceSlug) continue;
    const prior = byTarget.get(r.slug);
    byTarget.set(r.slug, (prior ?? false) || r.resolved);
  }

  const engine = storage.engine();
  // When scoped, the delete + insert confine to this source so a per-tenant
  // re-put never clears another tenant's wikilink edges. Unscoped (NULL) keeps
  // the original whole-source behavior.
  const delScope = scope !== null ? ` AND source_id = $2` : "";
  const insCol = scope !== null ? ", source_id" : "";
  const insVal = scope !== null ? ", $4" : "";
  return engine.transaction(async (tx) => {
    const delParams: unknown[] = [sourceSlug];
    if (scope !== null) delParams.push(scope);
    const del = await tx.query<{ c: number }>(
      `WITH d AS (
         DELETE FROM links
          WHERE source_slug = $1 AND type = 'wikilink'${delScope}
          RETURNING 1
       )
       SELECT COUNT(*)::int AS c FROM d`,
      delParams,
    );
    let added = 0;
    for (const [target, qualified] of byTarget) {
      // Each insert is idempotent against UNIQUE(source, target, type).
      // link_kind = 'plain' (deterministic scanner, not typed-NER);
      // resolution_type records whether a real page backed the target.
      const insParams: unknown[] = [
        sourceSlug,
        target,
        qualified ? "qualified" : "unqualified",
      ];
      if (scope !== null) insParams.push(scope);
      const ins = await tx.query<{ inserted: boolean }>(
        `INSERT INTO links
           (source_slug, target_slug, type, inferred_confidence,
            link_kind, resolution_type${insCol})
         VALUES ($1, $2, 'wikilink', 1.0, 'plain', $3${insVal})
         ON CONFLICT (source_slug, target_slug, type) DO NOTHING
         RETURNING (xmax = 0) AS inserted`,
        insParams,
      );
      if (ins.rows[0]?.inserted) added += 1;
    }
    return { removed: del.rows[0]?.c ?? 0, added };
  });
}
