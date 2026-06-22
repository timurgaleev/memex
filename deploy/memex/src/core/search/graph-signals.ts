/**
 * Selective graph signals — deterministic post-fusion ranking nudges that
 * read the link graph, no LLM involvement.
 *
 * Three additive signals, applied to the top-K of an already-fused,
 * sorted-desc result list (the caller re-sorts afterwards):
 *
 *   1. Adjacency-within-top-K (×1.05): a top-K page linked-to by >=2 OTHER
 *      top-K pages is a hub for this query — a small bump.
 *
 *   2. Cross-source adjacency (×1.10): a top-K page linked-to from >=2
 *      distinct OTHER sources is a federated-team hub. DORMANT on memex:
 *      the brain is single-source and `pages` carries no per-page source,
 *      so `cross_source_hits` is always 0. The arm is wired for parity and
 *      activates only if memex ever becomes multi-source.
 *
 *   3. Session diversification (×0.95): when several top-K results share a
 *      session prefix (a `chat/` marker or a YYYY-MM-DD segment), keep the
 *      highest-scoring one at full score and DEMOTE the rest. MMR-lite —
 *      stops one transcript's many chunks from crowding out stronger
 *      non-session hits. Entity/topic directories (`people/`, `docs/`) are
 *      NOT sessions and are never diversified.
 *
 * Conservative magnitudes so multiplicative composition can't catastrophically
 * reorder tight score bands. Opt-in, default OFF (the live ranking model is
 * immutable unless explicitly enabled). Fail-open: any SQL error leaves the
 * caller's results untouched.
 *
 * Adaptation note vs the reference: memex links are keyed by page SLUG
 * (`links.source_slug`/`target_slug`), not by page id, so the adjacency query
 * runs on slugs and the engine interface stays untouched (inline SQL via the
 * generic `engine.query`). On memex's mostly file-indexed corpus the adjacency
 * arm only fires for page-derived hits (`page://<slug>`) whose slug is in the
 * link graph — coverage grows as the brain becomes page-centric. The
 * reference's score-distribution probe + JSONL failure audit (telemetry for a
 * future calibration wave) are intentionally omitted here.
 */
import type { Engine } from "../engine/interface.ts";

/** Multiplier when in-set inbound links >= ADJACENCY_MIN_HITS. */
export const ADJACENCY_BOOST = 1.05;
/** Multiplier when distinct OTHER sources >= CROSS_SOURCE_MIN_HITS. Stacks
 *  on top of ADJACENCY_BOOST. Dormant on single-source memex. */
export const CROSS_SOURCE_BOOST = 1.1;
/** Sub-1.0 multiplier applied to non-top members of a session group. */
export const SESSION_DEMOTE = 0.95;
/** How many top-ranked results to consider. */
export const DEFAULT_TOP_K = 20;
/** Minimum in-set inbound link count before adjacency fires. */
export const ADJACENCY_MIN_HITS = 2;
/** Minimum distinct OTHER source count before cross-source fires. */
export const CROSS_SOURCE_MIN_HITS = 2;
/** Minimum group size before session diversification fires. */
export const SESSION_MIN_SHARE = 2;

const PAGE_SCHEME = "page://";

/** One adjacency tally for a target slug, restricted to the input set. */
export interface AdjacencyRow {
  hits: number;
  cross_source_hits: number;
}

export interface GraphSignalsMeta {
  enabled: boolean;
  top_k_size: number;
  adjacency_fires: number;
  cross_source_fires: number;
  session_demotions: number;
  errored: boolean;
}

/** Minimal shape this stage needs from a scored hit. Mutated in place. */
export interface GraphSignalScorable {
  score: number;
  payload?: { sourcePath?: string } | undefined;
}

export interface GraphSignalsOpts {
  /** Master gate. False short-circuits to a no-op. */
  enabled: boolean;
  /** Top-K size (default DEFAULT_TOP_K). */
  topK?: number;
  /**
   * Absolute score floor: hits below it skip ALL graph boosts. Pass
   * undefined to disable the gate (memex computes no floor today; the
   * param exists for parity + tests).
   */
  floorThreshold?: number;
  /** Test seam: replaces the inline links query. */
  adjacencyFn?: (slugs: string[]) => Promise<Map<string, AdjacencyRow>>;
  /** Observability sink — called once with fire counts. */
  onMeta?: (meta: GraphSignalsMeta) => void;
}

/**
 * Derive the link-graph slug for a hit. Page-derived documents are keyed
 * `page://<slug>`; their graph slug is the suffix. Anything else keeps its
 * raw source_path (which won't match a page slug, so it simply never gets a
 * boost — fail-safe).
 */
export function slugForSourcePath(sourcePath: string): string {
  return sourcePath.startsWith(PAGE_SCHEME)
    ? sourcePath.slice(PAGE_SCHEME.length)
    : sourcePath;
}

const DATE_SEGMENT_RE = /^\d{4}-\d{2}-\d{2}/;
// Only 'chat'/'session'/'sessions' MARK a session id in the next segment.
// 'transcripts'/'meetings' are CATEGORIES (parents of sessions), not markers.
const SESSION_MARKERS = new Set(["chat", "session", "sessions"]);

/**
 * Session-like slugs carry a `chat/`-style marker or a YYYY-MM-DD segment.
 * Returns the session prefix (everything up to and including the session id /
 * date), or null when the slug is an entity/topic directory and must NOT be
 * diversified.
 *
 *   media/chat/2026-05-20-foo/chunk-001 -> 'media/chat/2026-05-20-foo'
 *   daily/2026-05-20/journal-1          -> 'daily/2026-05-20'
 *   people/alice                        -> null
 */
export function sessionPrefix(slug: string): string | null {
  if (!slug.includes("/")) return null;
  const segments = slug.split("/");
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg === undefined) continue;
    if (SESSION_MARKERS.has(seg)) {
      const sessionIdIdx = Math.min(i + 1, segments.length - 1);
      return segments.slice(0, sessionIdIdx + 1).join("/");
    }
    if (DATE_SEGMENT_RE.test(seg)) {
      return segments.slice(0, i + 1).join("/");
    }
  }
  return null;
}

/**
 * Inline adjacency tally over the `links` table, restricted to the input
 * slug set's induced subgraph. `hits` = distinct in-set source_slugs linking
 * to each target (self-links excluded). Both endpoints must be live pages.
 * cross_source_hits is always 0 (single-source memex; `pages` has no per-page
 * source).
 *
 * The `HAVING >= 1` keeps every target with at least one in-set inbound link,
 * NOT the adjacency-fire threshold (that's ADJACENCY_MIN_HITS, applied by the
 * caller). The lower SQL bound is deliberate: it leaves rows available for the
 * cross-source arm, which fires independently of the adjacency count once the
 * brain is multi-source.
 */
async function defaultAdjacency(
  engine: Engine,
  slugs: string[],
): Promise<Map<string, AdjacencyRow>> {
  const result = new Map<string, AdjacencyRow>();
  if (slugs.length === 0) return result;
  const rows = await engine.query<{ to_slug: string; hits: number }>(
    `SELECT l.target_slug AS to_slug,
            COUNT(DISTINCT l.source_slug)::int AS hits
       FROM links l
       JOIN pages tp ON tp.slug = l.target_slug AND tp.deleted_at IS NULL
       JOIN pages sp ON sp.slug = l.source_slug AND sp.deleted_at IS NULL
      WHERE l.source_slug = ANY($1::text[])
        AND l.target_slug = ANY($1::text[])
        AND l.source_slug <> l.target_slug
      GROUP BY l.target_slug
     HAVING COUNT(DISTINCT l.source_slug) >= 1`,
    [slugs],
  );
  for (const r of rows.rows) {
    result.set(r.to_slug, { hits: Number(r.hits), cross_source_hits: 0 });
  }
  return result;
}

/**
 * Apply the three signals to a sorted-desc result list. Mutates `score` in
 * place; the caller re-sorts. No-op (with zero-meta) when disabled or empty.
 */
export async function applyGraphSignals(
  results: GraphSignalScorable[],
  engine: Engine,
  opts: GraphSignalsOpts,
): Promise<void> {
  const meta: GraphSignalsMeta = {
    enabled: opts.enabled,
    top_k_size: 0,
    adjacency_fires: 0,
    cross_source_fires: 0,
    session_demotions: 0,
    errored: false,
  };
  if (!opts.enabled || results.length === 0) {
    opts.onMeta?.(meta);
    return;
  }

  const topK = results.slice(0, opts.topK ?? DEFAULT_TOP_K);
  meta.top_k_size = topK.length;

  // Collapse to one REPRESENTATIVE (highest-scoring) chunk per page slug. The
  // signals act on the page, not on each of its chunks: `results` here is the
  // pre-dedup chunk list (and `exact` intent skips per-doc dedup entirely), so
  // without this a hub with N in-band chunks would be boosted N times. The
  // representative is the chunk that survives per-doc dedup downstream, so
  // boosting it is the page-granular equivalent of the reference's per-page
  // post-fusion pool.
  const repBySlug = new Map<string, GraphSignalScorable>();
  for (const r of topK) {
    const slug = slugForSourcePath(r.payload?.sourcePath ?? "");
    if (slug.length === 0) continue;
    const existing = repBySlug.get(slug);
    if (existing === undefined || r.score > existing.score) {
      repBySlug.set(slug, r);
    }
  }
  const uniqueSlugs = Array.from(repBySlug.keys());

  // ---- Adjacency + cross-source ----
  let adjacency: Map<string, AdjacencyRow>;
  try {
    adjacency = opts.adjacencyFn
      ? await opts.adjacencyFn(uniqueSlugs)
      : await defaultAdjacency(engine, uniqueSlugs);
  } catch (err) {
    // Fail-open: leave results untouched. Session diversification also
    // skips (predictable all-or-nothing posture).
    meta.errored = true;
    opts.onMeta?.(meta);
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`graph-signals: adjacency failed (${msg}); search continues`);
    return;
  }

  const floor = opts.floorThreshold;
  for (const [slug, rep] of repBySlug) {
    if (floor !== undefined && !(rep.score >= floor)) continue;
    const row = adjacency.get(slug);
    if (!row) continue;
    if (row.hits >= ADJACENCY_MIN_HITS) {
      rep.score *= ADJACENCY_BOOST;
      meta.adjacency_fires++;
    }
    if (row.cross_source_hits >= CROSS_SOURCE_MIN_HITS) {
      rep.score *= CROSS_SOURCE_BOOST;
      meta.cross_source_fires++;
    }
  }

  // ---- Session diversification ----
  // Group representatives (one per page) by session prefix, so distinct pages
  // of one session compete; a single page's extra chunks never self-demote.
  const groups = new Map<string, Array<{ slug: string; rep: GraphSignalScorable }>>();
  for (const [slug, rep] of repBySlug) {
    const prefix = sessionPrefix(slug);
    if (prefix === null) continue;
    let group = groups.get(prefix);
    if (!group) {
      group = [];
      groups.set(prefix, group);
    }
    group.push({ slug, rep });
  }
  for (const members of groups.values()) {
    if (members.length < SESSION_MIN_SHARE) continue;
    // Keep the highest-scoring page (post-adjacency) at full score; demote the
    // rest. Stable by slug for deterministic ties.
    members.sort((a, b) => {
      if (b.rep.score !== a.rep.score) return b.rep.score - a.rep.score;
      return a.slug.localeCompare(b.slug);
    });
    for (let i = 1; i < members.length; i++) {
      const m = members[i];
      if (m === undefined) continue;
      m.rep.score *= SESSION_DEMOTE;
      meta.session_demotions++;
    }
  }

  opts.onMeta?.(meta);
}
