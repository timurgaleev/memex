/**
 * "Did you mean" for a page slug that missed.
 *
 * Two kinds of candidate, in one query over the caller's readable, live pages:
 *   - affix: the slug with the caller's write source stripped from the front
 *     (as often as it repeats) or added to it. Agents that know their source id
 *     tend to prefix it onto every slug (`me/notes/x` for `notes/x`).
 *   - nearest: the closest slugs by pg_trgm similarity, threshold-gated. The
 *     same function `resolve_slugs` uses (migration 033 enables pg_trgm on both
 *     engines); like there, no trigram index is needed at this scale, and the
 *     scan runs only on a miss.
 *
 * The scope is the one every read uses (`andSourceScope`), so a caller is never
 * shown a slug it could not read. The missed slug itself is never suggested: a
 * page the caller may not see (a fenced diary page) must look like a plain miss.
 */
import type { Storage } from "./storage.ts";
import { andSourceScope, type SourceScope } from "./source-scope.ts";

export interface SuggestSlugsOptions {
  /** The caller's read scope. Undefined = unscoped (operator). */
  sourceIds: SourceScope;
  /** The caller's write source, for the prefix candidates. */
  writeSource?: string | undefined;
  /** Drop a candidate the caller may read by scope but must not be shown. */
  exclude?: (slug: string, type: string | null) => boolean;
  /** Max nearest-by-similarity candidates. Default 3. */
  nearest?: number;
}

const DEFAULT_NEAREST = 3;
const SIMILARITY_THRESHOLD = 0.3;
/** Headroom so `exclude` can drop rows without starving the result. */
const EXCLUDE_SLACK = 5;

/** The slug with `<writeSource>/` stripped (each repetition) or added. */
export function affixCandidates(slug: string, writeSource: string | undefined): string[] {
  if (!writeSource) return [];
  const prefix = `${writeSource}/`;
  const out = new Set<string>();
  let s = slug;
  while (s.startsWith(prefix)) {
    s = s.slice(prefix.length);
    if (s.length > 0) out.add(s);
  }
  if (!slug.startsWith(prefix)) out.add(`${prefix}${slug}`);
  out.delete(slug);
  return [...out];
}

/** Readable slugs close to `slug`, affix matches first. */
export async function suggestSlugs(
  storage: Storage,
  slug: string,
  opts: SuggestSlugsOptions,
): Promise<string[]> {
  const nearest = opts.nearest ?? DEFAULT_NEAREST;
  const affixes = affixCandidates(slug, opts.writeSource);
  const params: unknown[] = [slug, affixes, SIMILARITY_THRESHOLD, affixes.length + nearest + EXCLUDE_SLACK];
  const scope = andSourceScope("source_id", opts.sourceIds, params);
  const r = await storage.engine().query<{ slug: string; type: string | null; affix: boolean }>(
    `SELECT slug, type, (slug = ANY($2::text[])) AS affix
       FROM pages
      WHERE deleted_at IS NULL AND slug <> $1${scope}
        AND (slug = ANY($2::text[]) OR similarity(slug, $1) >= $3)
      ORDER BY affix DESC, similarity(slug, $1) DESC, slug ASC
      LIMIT $4`,
    params,
  );
  const out: string[] = [];
  let near = 0;
  for (const row of r.rows) {
    if (opts.exclude?.(row.slug, row.type)) continue;
    if (!row.affix) {
      if (near >= nearest) continue;
      near++;
    }
    out.push(row.slug);
  }
  return out;
}
