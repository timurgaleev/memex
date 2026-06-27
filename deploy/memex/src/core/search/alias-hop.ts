/**
 * Alias-hop — when the normalized query EXACTLY matches a page's declared
 * free-text alias, make sure that page is in the result set: boost it if
 * already present, inject it at top-of-organic + ε if absent. The only layer
 * that bridges true synonyms with zero surface overlap ("Bobby" → `people/bob`)
 * — neither keyword nor title-boost can.
 *
 * Faithful port of the reference's `applyAliasHop`, adapted to memex's stack
 * (chunk-level SearchHit + the `page://<slug>` page→document bridge instead of
 * page-level SearchResult). Precision guards (verbatim from the reference):
 *   - FULL normalized-query exact match only (not substring / not n-grams);
 *   - skip queries longer than MAX_ALIAS_QUERY_TOKENS (prose, not a name);
 *   - bounded: present-boost is ×1.10; an injected page lands at
 *     top-of-organic + ε, NEVER an absolute score (aliases are not a ranking
 *     sledgehammer);
 *   - collisions (two pages claim one alias): deterministic (source_id, slug)
 *     order, capped at MAX_ALIAS_INJECT.
 *
 * Fail-open: a pre-migration-034 brain (no `page_aliases` table) or any lookup
 * error degrades to the input unchanged. Returns a NEW array; the caller
 * re-slices. Default ON; MEMEX_ALIAS_HOP=0 disables (folded into the
 * query-cache ranking signature).
 */
import type { Engine } from "../engine/interface.ts";
import type { Storage } from "../storage.ts";
import type { Intent } from "./intent.ts";
import type { SearchHit } from "./hybrid.ts";
import { visibilityClause } from "../visibility.ts";
import { normalizeAlias, resolveAliasCandidates } from "../page-aliases.ts";
import { slugForSourcePath } from "./graph-signals.ts";
import { createSafetyFor } from "./evidence.ts";

/** Bounded boost when the canonical page is already in the results. */
export const ALIAS_HOP_PRESENT_BOOST = 1.1;
/** Queries longer than this (whitespace tokens) never alias-hop. */
export const MAX_ALIAS_QUERY_TOKENS = 6;
/** Cap on canonical pages boosted/injected per query (collision safety). */
export const MAX_ALIAS_INJECT = 3;

/** Default ON; MEMEX_ALIAS_HOP=0 disables the stage. */
export function aliasHopEnabled(): boolean {
  return process.env["MEMEX_ALIAS_HOP"] !== "0";
}

/** Test seams: replace the alias-candidate lookup / page-head fetch (no DB). */
export interface AliasHopOpts {
  resolveCandidates?: (
    norm: string,
  ) => Promise<Array<{ slug: string; source_id: string }>>;
  fetchHead?: (slug: string, sourceId: string) => Promise<SearchHit | null>;
}

/**
 * Apply the alias-hop to a post-rerank result list. A no-op when the query is
 * not exactly a declared alias. Returns a NEW array (boosted/injected +
 * re-sorted by score).
 */
export async function applyAliasHop(
  hits: SearchHit[],
  storage: Storage,
  query: string,
  intent: Intent,
  sourceIds: readonly string[] | undefined,
  opts: AliasHopOpts = {},
): Promise<SearchHit[]> {
  if (!query) return hits;
  const qNorm = normalizeAlias(query);
  if (!qNorm || qNorm.split(" ").length > MAX_ALIAS_QUERY_TOKENS) return hits;

  const scope = sourceIds && sourceIds.length > 0 ? [...sourceIds] : undefined;
  let refs: Array<{ slug: string; source_id: string }>;
  try {
    refs = opts.resolveCandidates
      ? await opts.resolveCandidates(qNorm)
      : await resolveAliasCandidates(storage, qNorm, scope);
  } catch {
    return hits; // pre-034 table-missing OR transient error → fail-open
  }
  if (refs.length === 0) return hits;

  // Deterministic + capped: order by (source_id, slug) so a federated caller
  // boosts/injects the RIGHT source's page, never collapsing or cross-injecting.
  const ordered = [...refs]
    .sort((a, b) =>
      a.source_id === b.source_id
        ? a.slug.localeCompare(b.slug)
        : a.source_id.localeCompare(b.source_id),
    )
    .slice(0, MAX_ALIAS_INJECT);

  const out = [...hits];
  const topScore = out.reduce(
    (m, r) => (Number.isFinite(r.score) && r.score > m ? r.score : m),
    0,
  );
  let injectScore = topScore > 0 ? topScore : 1.0;

  for (const ref of ordered) {
    const idx = out.findIndex((r) => slugForSourcePath(r.sourcePath) === ref.slug);
    if (idx >= 0) {
      // Present → ×1.10 + alias_hit evidence. Immutable replace (memex style
      // rule) rather than the reference's in-place mutation.
      const h = out[idx]!;
      out[idx] = {
        ...h,
        score: Number.isFinite(h.score) ? h.score * ALIAS_HOP_PRESENT_BOOST : h.score,
        evidence: "alias_hit",
        create_safety: createSafetyFor("alias_hit"),
      };
      continue;
    }
    // Absent → fetch the canonical page's head chunk (in ITS source) + inject
    // at top-of-organic + ε. The ε increments per inject so multiple collision
    // claimants stack just above the organic top without leapfrogging.
    const injected = opts.fetchHead
      ? await opts.fetchHead(ref.slug, ref.source_id)
      : await fetchPageHeadHit(
          storage.engine(),
          ref.slug,
          intent,
          ref.source_id ? [ref.source_id] : scope,
        );
    if (!injected) continue;
    injectScore += 1e-6;
    injected.score = injectScore;
    injected.evidence = "alias_hit";
    injected.create_safety = createSafetyFor("alias_hit");
    out.push(injected);
  }

  out.sort((a, b) => b.score - a.score);
  return out;
}

/**
 * Fetch the representative (lowest-id) chunk of a page as a SearchHit, confined
 * to the given sources and the visibility filter. Returns null when the page
 * has no live indexed chunk in scope.
 */
async function fetchPageHeadHit(
  engine: Engine,
  slug: string,
  intent: Intent,
  scope: string[] | undefined,
): Promise<SearchHit | null> {
  const params: unknown[] = [`page://${slug}`];
  let scopeFilter = "";
  if (scope && scope.length > 0) {
    params.push(scope);
    scopeFilter = ` AND d.source_id = ANY($${params.length}::text[])`;
  }
  const r = await engine.query<{
    id: string;
    document_id: string;
    content: string;
    source_path: string;
    title: string | null;
  }>(
    `SELECT c.id, c.document_id, c.content, d.source_path, d.title
       FROM chunks c
       JOIN documents d ON d.id = c.document_id
      WHERE d.source_path = $1${scopeFilter}
        AND ${visibilityClause("d")}
      ORDER BY c.id
      LIMIT 1`,
    params,
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    chunkId: row.id,
    documentId: row.document_id,
    sourcePath: row.source_path,
    title: row.title,
    content: row.content,
    score: 0,
    intent,
  };
}
