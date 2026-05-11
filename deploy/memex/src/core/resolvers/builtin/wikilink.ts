/**
 * Wikilink resolver — `[[Foo]]` → document whose title or filename
 * matches "Foo". Title match is case- and whitespace-insensitive;
 * filename match looks for `<name>.md` at the end of `source_path`.
 *
 * Mirrors the inline SQL in `core/cycle/reconcile-links.ts` so that
 * `check-resolvable` (which goes through the resolver registry) and
 * `reconcile-links` (which inlines the same query for hot-path reasons)
 * agree on what "resolved" means.
 */
import type { Resolver, ResolveContext, ResolveResult } from "../interface.ts";

interface DocHit {
  id: string;
  source_path: string;
  title: string;
}

export const wikilinkResolver: Resolver = {
  kind: "wikilink",
  async resolve(input: string, ctx: ResolveContext): Promise<ResolveResult> {
    const trimmed = input.trim();
    if (trimmed.length === 0) {
      return { documentId: null };
    }
    const r = await ctx.engine.query<DocHit>(
      `SELECT id, source_path, title
         FROM documents
        WHERE lower(trim(title)) = lower($1)
           OR source_path ILIKE '%/' || $2 || '.md'
        LIMIT 1`,
      [trimmed.toLowerCase(), trimmed],
    );
    const hit = r.rows[0];
    if (!hit) return { documentId: null };
    return {
      documentId: hit.id,
      detail: { sourcePath: hit.source_path, title: hit.title },
    };
  },
};
