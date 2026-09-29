/**
 * Alias-resolved canonical boost — a hit whose page slug
 * is the `canonical_slug` of one or more `slug_aliases` rows (migration 067)
 * gets a gentle ×1.05: old slugs forward to it, i.e. the user (or a merge)
 * explicitly disambiguated this page as the authoritative version.
 *
 * Distinct from alias-hop (free-text alias → page injection): this stage
 * never injects, it only nudges pages that are already in the candidate set.
 * Source-scoped: the (source_id, canonical_slug) composite is matched, so one
 * tenant's redirect never boosts another tenant's same-slug page.
 *
 * One bounded query over the candidate set's derived slugs. Fail-open — the
 * caller wraps in try/catch; a pre-migration store simply no-ops.
 */
import type { Engine } from "../engine/interface.ts";
import { slugCandidatesForPath } from "./page-slug.ts";

export const ALIAS_RESOLVED_BOOST = 1.05;

export interface AliasResolvableHit {
  score: number;
  payload?: {
    sourcePath?: string;
    source_id?: string | null;
  };
}

/**
 * Multiply alias-resolved canonical hits in place. Returns the set of
 * touched indices so the caller can stamp explain attribution.
 */
export async function applyAliasResolvedBoost(
  scored: readonly AliasResolvableHit[],
  engine: Engine,
): Promise<Set<number>> {
  const touched = new Set<number>();
  if (scored.length === 0) return touched;
  const perHit = scored.map((s) =>
    slugCandidatesForPath(s.payload?.sourcePath ?? null, s.payload?.source_id ?? null),
  );
  const refs = new Map<string, { sourceId: string; slug: string }>();
  for (let i = 0; i < scored.length; i++) {
    const sid = scored[i]!.payload?.source_id ?? "default";
    for (const slug of perHit[i]!) {
      refs.set(`${sid}::${slug}`, { sourceId: sid, slug });
    }
  }
  if (refs.size === 0) return touched;
  const list = [...refs.values()];
  const r = await engine.query<{ source_id: string; canonical_slug: string }>(
    `SELECT DISTINCT source_id, canonical_slug
       FROM slug_aliases
      WHERE (source_id, canonical_slug) IN (
        SELECT * FROM unnest($1::text[], $2::text[])
      )`,
    [list.map((x) => x.sourceId), list.map((x) => x.slug)],
  );
  if (r.rows.length === 0) return touched;
  const canonical = new Set(r.rows.map((row) => `${row.source_id}::${row.canonical_slug}`));
  for (let i = 0; i < scored.length; i++) {
    const s = scored[i]!;
    if (!Number.isFinite(s.score)) continue;
    const sid = s.payload?.source_id ?? "default";
    if (perHit[i]!.some((slug) => canonical.has(`${sid}::${slug}`))) {
      s.score *= ALIAS_RESOLVED_BOOST;
      touched.add(i);
    }
  }
  return touched;
}
