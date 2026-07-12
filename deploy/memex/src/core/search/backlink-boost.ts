/**
 * Backlink-count boost — a deterministic, standing hub signal.
 *
 * A page's score is multiplied by `1 + BACKLINK_BOOST_COEF * ln(1 + count)`,
 * where `count` is the page's GLOBAL inbound link count from the `links` table
 * (distinct source pages that link to it). Unlike the opt-in graph-signals
 * stage — which counts only links WITHIN the current result set — this reads
 * the whole-corpus in-degree, so a well-connected hub gets a small standing
 * boost on every query even when none of its neighbors made the result set.
 *
 * Magnitudes (COEF = 0.05):
 *   0 links  → ×1.00 (no boost)
 *   1 link   → ×1.035
 *   10 links → ×1.12
 *   100 links→ ×1.23
 *
 * `link_source = 'mentions'` links are EXCLUDED (mig086 provenance): those are
 * auto-linked body-text mentions and
 * verb-inferred edges (graph-completeness signal), not an intentional human
 * reference, and counting them would let popular-mention pages dominate
 * ranking. Self-links are excluded too. The boost is floor-ratio-gated exactly like graph-signals
 * (reusing computeFloorThreshold): a hit must score within `ratio` of the top
 * hit to be eligible, so a weak tail hit can't be lifted past a strong primary
 * one. Fail-open: any links-query error leaves scores untouched.
 *
 * memex links are keyed by page SLUG (`links.target_slug`), so a hit's slug is
 * derived via `slugForSourcePath` (shared with graph-signals). File-indexed
 * chunks whose path is not a `page://` slug simply never match a link row —
 * neutral, never a penalty.
 */
import type { Engine } from "../engine/interface.ts";
import { slugForSourcePath } from "./graph-signals.ts";

/** Score multiplier is 1 + COEF * ln(1 + inbound_link_count). */
export const BACKLINK_BOOST_COEF = 0.05;

/** Minimal shape this stage needs from a scored hit. Mutated in place. */
export interface BacklinkScorable {
  score: number;
  payload?: { sourcePath?: string } | undefined;
}

/** Injectable count source — the SQL tally, or a test seam. */
export type BacklinkCountFn = (slugs: string[]) => Promise<Map<string, number>>;

/**
 * Global inbound-link tally over the `links` table: for each input slug, the
 * number of DISTINCT other pages that link to it (self-links and `mentions`
 * links excluded). Both endpoints must be live pages. Tenant-scoped by
 * `links.source_id` (migration 047) when `sourceIds` is set — a scoped caller
 * never inherits another source's hub signal; no-op (whole graph) when unset.
 */
export async function defaultBacklinkCounts(
  engine: Engine,
  slugs: string[],
  sourceIds?: readonly string[],
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (slugs.length === 0) return result;
  const params: unknown[] = [slugs];
  let sourceFilter = "";
  if (sourceIds && sourceIds.length) {
    params.push(sourceIds);
    sourceFilter = ` AND l.source_id = ANY($${params.length}::text[])`;
  }
  const rows = await engine.query<{ to_slug: string; cnt: number }>(
    `SELECT l.target_slug AS to_slug,
            COUNT(DISTINCT l.source_slug)::int AS cnt
       FROM links l
       JOIN pages tp ON tp.slug = l.target_slug AND tp.deleted_at IS NULL
       JOIN pages sp ON sp.slug = l.source_slug AND sp.deleted_at IS NULL
      WHERE l.target_slug = ANY($1::text[])
        AND l.source_slug <> l.target_slug
        AND l.link_source <> 'mentions'${sourceFilter}
      GROUP BY l.target_slug`,
    params,
  );
  for (const r of rows.rows) {
    result.set(r.to_slug, Number(r.cnt));
  }
  return result;
}

export interface BacklinkBoostOpts {
  /**
   * Absolute score floor: hits scoring below it skip the boost. Derive it via
   * computeFloorThreshold from the candidate set + the floor ratio, exactly as
   * the graph-signals stage does. Undefined/NEGATIVE_INFINITY disables the gate.
   */
  floorThreshold?: number;
  /** Tenant scope — restricts the links tally to these sources. */
  sourceIds?: readonly string[];
  /** Test seam: replaces the inline links tally. */
  countFn?: BacklinkCountFn;
}

/**
 * Apply the backlink-count boost to a scored list in place. Collapses to one
 * lookup per distinct slug, then multiplies each hit's score by its slug's
 * factor. Caller re-sorts afterwards. No-op on an empty list. Fail-open: a
 * tally error leaves every score untouched.
 */
export async function applyBacklinkBoost(
  results: BacklinkScorable[],
  engine: Engine,
  opts: BacklinkBoostOpts = {},
): Promise<void> {
  if (results.length === 0) return;

  const slugByResult = results.map((r) => slugForSourcePath(r.payload?.sourcePath ?? ""));
  const uniqueSlugs = Array.from(new Set(slugByResult.filter((s) => s.length > 0)));
  if (uniqueSlugs.length === 0) return;

  let counts: Map<string, number>;
  try {
    counts = opts.countFn
      ? await opts.countFn(uniqueSlugs)
      : await defaultBacklinkCounts(engine, uniqueSlugs, opts.sourceIds);
  } catch (err) {
    // Fail-open: leave results untouched. Log server-side so a real bug in the
    // tally isn't silently masked as "no backlinks".
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`backlink-boost: count tally failed (${msg}); search continues`);
    return;
  }

  const floor = opts.floorThreshold;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r === undefined) continue;
    // Skip NaN/Infinity scores AND sub-floor hits (NaN >= floor is false, so the
    // guard also catches NaN when a floor is set — matches graph-signals).
    if (!Number.isFinite(r.score)) continue;
    if (floor !== undefined && !(r.score >= floor)) continue;
    const slug = slugByResult[i];
    if (slug === undefined || slug.length === 0) continue;
    const count = counts.get(slug) ?? 0;
    if (count > 0) {
      r.score *= 1 + BACKLINK_BOOST_COEF * Math.log(1 + count);
    }
  }
}
