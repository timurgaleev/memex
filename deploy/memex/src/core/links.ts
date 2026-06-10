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
  // On an idempotent re-add, provenance is STICKY: an omitted field (empty
  // context / NULL enum) preserves the prior value so a bare `link` re-call
  // never wipes enrichment-written provenance.
  const r = await storage.engine().query<{ inserted: boolean }>(
    `INSERT INTO links
       (source_slug, target_slug, type, inferred_confidence, source_chunk_id,
        context, link_kind, origin_slug, origin_field, resolution_type)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
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
    [input.source_slug, target, type, conf, chunkId,
     context, linkKind, originSlug, originField, resolutionType],
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
  const queries: string[] = [];
  if (direction === "outbound" || direction === "both") {
    queries.push(
      `SELECT id, source_slug, target_slug, type, inferred_confidence,
              source_chunk_id, written_at::text AS written_at,
              'outbound' AS direction
       FROM links
       WHERE source_slug = $1${typeFilter}`,
    );
  }
  if (direction === "inbound" || direction === "both") {
    queries.push(
      `SELECT id, source_slug, target_slug, type, inferred_confidence,
              source_chunk_id, written_at::text AS written_at,
              'inbound' AS direction
       FROM links
       WHERE target_slug = $1${typeFilter}`,
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
 */
export async function syncWikilinksForPage(
  storage: Storage,
  sourceSlug: string,
  body: string,
): Promise<{ removed: number; added: number }> {
  validateSlug(sourceSlug);
  const targets = extractWikilinks(body)
    .map((s) => slugifyTarget(s))
    .filter((s) => s !== "unknown");
  const engine = storage.engine();
  return engine.transaction(async (tx) => {
    const del = await tx.query<{ c: number }>(
      `WITH d AS (
         DELETE FROM links
          WHERE source_slug = $1 AND type = 'wikilink'
          RETURNING 1
       )
       SELECT COUNT(*)::int AS c FROM d`,
      [sourceSlug],
    );
    let added = 0;
    for (const target of targets) {
      // Each insert is idempotent against UNIQUE(source, target, type).
      const ins = await tx.query<{ inserted: boolean }>(
        `INSERT INTO links (source_slug, target_slug, type, inferred_confidence)
         VALUES ($1, $2, 'wikilink', 1.0)
         ON CONFLICT (source_slug, target_slug, type) DO NOTHING
         RETURNING (xmax = 0) AS inserted`,
        [sourceSlug, target],
      );
      if (ins.rows[0]?.inserted) added += 1;
    }
    return { removed: del.rows[0]?.c ?? 0, added };
  });
}
