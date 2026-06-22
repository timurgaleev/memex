/**
 * Slug resolution — turn a partial or informal string into the canonical
 * page slugs it most likely refers to, ranked best-first.
 *
 * Where `slug-canonicalize.ts` resolves ONE wikilink mention to a single
 * authoritative slug (a write-path concern, ambiguity → fall through), this
 * is the read-path counterpart: a remote caller hands us a fuzzy phrase
 * (`"alce smth"`, `"acme"`) and wants the matching pages back, scored. It
 * never arbitrates — it returns the candidate set and lets the caller pick.
 *
 * Matching is deterministic (no LLM): pg_trgm `similarity()` over both the
 * page title and the slug, taking the better of the two per page. We filter
 * on an explicit threshold (`similarity() >= t`) rather than the `%`
 * operator so no GIN trigram index is required — the function alone suffices
 * at this vault's scale (see migration 033, the same choice
 * `slug-canonicalize.ts` makes). An exact slug match always wins (score 1)
 * so an informal query that happens to be a real slug resolves to itself.
 *
 * Soft-deleted pages (`deleted_at IS NOT NULL`) are never candidates.
 */
import type { Storage } from "./storage.ts";

/** One resolved candidate, ordered by descending `score` by the caller. */
export interface SlugResolution {
  slug: string;
  title: string | null;
  /** pg_trgm similarity in [0, 1]; 1 for an exact slug match. */
  score: number;
}

export interface ResolveSlugsOptions {
  /** Max candidates to return. Default 5; clamped to [1, 100]. */
  limit?: number;
  /** Minimum similarity to keep a fuzzy candidate. Default 0.3. */
  threshold?: number;
}

const DEFAULT_LIMIT = 5;
const DEFAULT_THRESHOLD = 0.3;

/**
 * Resolve `query` to canonical page slugs, best-first.
 *
 * An exact (live) slug match short-circuits to a single score-1 result. The
 * fuzzy path returns up to `limit` pages whose title- or slug-similarity
 * clears `threshold`, ordered by score then slug for a stable tie-break.
 * Throws on an out-of-range `limit`/`threshold` so a typo fails loud rather
 * than silently returning the wrong slice.
 */
export async function resolveSlugs(
  storage: Storage,
  query: string,
  opts: ResolveSlugsOptions = {},
): Promise<SlugResolution[]> {
  const q = typeof query === "string" ? query.trim() : "";
  if (q === "") return [];

  const limit = opts.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error(`resolveSlugs: limit must be in [1, 100] (got ${limit})`);
  }
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error(
      `resolveSlugs: threshold must be in [0, 1] (got ${threshold})`,
    );
  }

  const db = storage.engine();

  // Exact slug match wins outright — an informal query that IS a live slug
  // resolves to itself at full confidence, never diluted by a fuzzy runner-up.
  const exact = await db.query<{ slug: string; title: string | null }>(
    `SELECT slug, title FROM pages
      WHERE slug = $1 AND deleted_at IS NULL
      LIMIT 1`,
    [q],
  );
  if (exact.rows.length > 0) {
    return [{ slug: exact.rows[0]!.slug, title: exact.rows[0]!.title, score: 1 }];
  }

  // Fuzzy: better of title- vs slug-similarity per page, threshold-gated.
  const fuzzy = await db.query<{
    slug: string;
    title: string | null;
    score: number;
  }>(
    `SELECT slug, title,
            GREATEST(
              similarity(lower(COALESCE(title, '')), lower($1)),
              similarity(slug, lower($1))
            ) AS score
       FROM pages
      WHERE deleted_at IS NULL
        AND GREATEST(
              similarity(lower(COALESCE(title, '')), lower($1)),
              similarity(slug, lower($1))
            ) >= $2
      ORDER BY score DESC, slug ASC
      LIMIT $3`,
    [q, threshold, limit],
  );

  return fuzzy.rows.map((r) => ({
    slug: r.slug,
    title: r.title,
    score: Number(r.score),
  }));
}
