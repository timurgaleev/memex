/**
 * Derive page-slug candidates from a search hit's document source_path, so
 * slug-keyed page signals (pages.salience, slug_aliases) can join against
 * hits that come from either a page mirror or the file sweep:
 *
 *   - `page://<slug>`                    → slug (default tenant)
 *   - `page://<sourceId>/<slug>`         → slug (tenant-scoped mirror; the
 *                                          hit's own source_id disambiguates)
 *   - `page-truth://…`                   → same two forms
 *   - `people/x.md` / `people/x`         → `people/x` (file twin of a page)
 *
 * Returns [] when no plausible slug form exists (absolute paths, code files).
 */
export function slugCandidatesForPath(
  sourcePath: string | null | undefined,
  sourceId: string | null | undefined,
): string[] {
  if (!sourcePath) return [];
  let rest: string | null = null;
  if (sourcePath.startsWith("page-truth://")) rest = sourcePath.slice("page-truth://".length);
  else if (sourcePath.startsWith("page://")) rest = sourcePath.slice("page://".length);
  if (rest !== null) {
    const out = [rest];
    // A non-default tenant's mirror id embeds the source: strip it too. The
    // bare form stays a candidate — `page://a/b` is ambiguous between slug
    // `a/b` (default) and slug `b` (tenant `a`); the join is read-only and a
    // false candidate simply misses.
    if (sourceId && sourceId !== "default" && rest.startsWith(`${sourceId}/`)) {
      out.push(rest.slice(sourceId.length + 1));
    }
    return out.filter((s) => s.length > 0);
  }
  // File-sweep documents: a relative markdown path can be a page's file twin.
  if (sourcePath.startsWith("/") || sourcePath.includes("://")) return [];
  const noExt = sourcePath.replace(/\.(md|markdown)$/i, "");
  return noExt.length > 0 ? [noExt] : [];
}
