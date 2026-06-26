/**
 * Alias-hop — surface the canonical page when the WHOLE query is a declared
 * alias of it.
 *
 * A page declares free-text aliases in `compiled_truth.aliases` (migration 034,
 * indexed in `page_aliases`). The wikilink resolver already consults that index,
 * but search did not: a query that is exactly an alias (e.g. "Bobby" for
 * `people/bob`) would miss the page entirely when the alias never appears in the
 * page body. This stage closes that gap, mirroring the reference's `applyAliasHop`:
 *
 *   1. Normalize the FULL query (NFKC + lowercase + collapse) and require an
 *      EXACT match to a declared alias — not a substring, not an n-gram. Skip
 *      queries longer than MAX_ALIAS_QUERY_TOKENS tokens (an alias is a name,
 *      not a sentence). This exact-match gate keeps the blast radius tiny: a
 *      normal query that isn't itself an alias is a no-op.
 *   2. Resolve via `page_aliases` to a UNIQUE canonical slug (a collision —
 *      one alias claimed by two pages — resolves to nothing, same safe-by-
 *      default posture as the slug canonicalizer).
 *   3. If the canonical page is already in the result set, boost its best chunk
 *      by ALIAS_HOP_PRESENT_BOOST and re-sort. If it is absent, fetch its
 *      representative chunk (source-scoped + visibility-filtered) and inject it
 *      at the head.
 *
 * Runs AFTER rerank/dedup on the full pre-trim list, so an injected page cannot
 * be trimmed out. Default ON (the exact-match gate makes it safe); set
 * MEMEX_ALIAS_HOP=0 to disable. The on/off flag is folded into the query-cache
 * ranking signature.
 */
import type { Engine } from "../engine/interface.ts";
import type { Storage } from "../storage.ts";
import type { Intent } from "./intent.ts";
import type { SearchHit } from "./hybrid.ts";
import { visibilityClause } from "../visibility.ts";
import {
  normalizeAlias,
  isIndexableAlias,
  resolveAliasUnique,
} from "../page-aliases.ts";
import { slugForSourcePath } from "./graph-signals.ts";
import { createSafetyFor } from "./evidence.ts";

/** Multiplier applied to the canonical page when it is already in the results. */
export const ALIAS_HOP_PRESENT_BOOST = 1.1;
/** Queries longer than this (in whitespace tokens) never alias-hop. */
export const MAX_ALIAS_QUERY_TOKENS = 6;

const PAGE_SCHEME = "page://";

/** Default ON; MEMEX_ALIAS_HOP=0 disables the stage. */
export function aliasHopEnabled(): boolean {
  return process.env["MEMEX_ALIAS_HOP"] !== "0";
}

/** Test seams: replace the alias resolver / page-head fetch (no DB in tests). */
export interface AliasHopOpts {
  resolveAlias?: (norm: string) => Promise<string | null>;
  fetchHead?: (slug: string) => Promise<SearchHit | null>;
}

/**
 * Apply the alias-hop to a post-rerank result list. Returns a possibly-modified
 * list (boosted + re-sorted, or with a canonical page injected at the head).
 * A no-op when the query is not exactly a uniquely-resolvable alias.
 */
export async function applyAliasHop(
  hits: SearchHit[],
  storage: Storage,
  query: string,
  intent: Intent,
  sourceIds: readonly string[] | undefined,
  opts: AliasHopOpts = {},
): Promise<SearchHit[]> {
  const norm = normalizeAlias(query);
  if (!isIndexableAlias(norm)) return hits;
  if (norm.split(" ").length > MAX_ALIAS_QUERY_TOKENS) return hits;

  const scope =
    sourceIds && sourceIds.length > 0 ? [...sourceIds] : undefined;
  const resolve =
    opts.resolveAlias ?? ((n: string) => resolveAliasUnique(storage, n, "", scope));
  const slug = await resolve(norm);
  if (!slug) return hits; // miss or collision → no-op

  // Canonical page already present → boost its best chunk and re-sort. All
  // chunks of a page share one `page://<slug>` source_path, so a single find
  // covers every chunk of the page.
  const presentIdx = hits.findIndex(
    (h) => slugForSourcePath(h.sourcePath) === slug,
  );
  if (presentIdx !== -1) {
    // Immutable: replace the matched hit with a boosted copy carrying the
    // alias_hit evidence (an exact alias match IS a "this page exists" signal);
    // never mutate the caller's element in place.
    const boosted = hits.map((h, i) =>
      i === presentIdx
        ? {
            ...h,
            score: h.score * ALIAS_HOP_PRESENT_BOOST,
            evidence: "alias_hit" as const,
            create_safety: createSafetyFor("alias_hit"),
          }
        : h,
    );
    return boosted.sort((a, b) => b.score - a.score);
  }

  // Absent → inject the canonical page's representative chunk at the head.
  const fetch =
    opts.fetchHead ??
    ((s: string) => fetchPageHeadHit(storage.engine(), s, intent, scope));
  const injected = await fetch(slug);
  if (!injected) return hits;
  injected.score = (hits[0]?.score ?? 1) * ALIAS_HOP_PRESENT_BOOST;
  injected.evidence = "alias_hit";
  injected.create_safety = createSafetyFor("alias_hit");
  return [injected, ...hits];
}

/**
 * Fetch the representative (lowest-id) chunk of a page as a SearchHit,
 * confined to the given sources and the visibility filter. Returns null when
 * the page has no live indexed chunk in scope.
 */
async function fetchPageHeadHit(
  engine: Engine,
  slug: string,
  intent: Intent,
  scope: string[] | undefined,
): Promise<SearchHit | null> {
  const params: unknown[] = [`${PAGE_SCHEME}${slug}`];
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
