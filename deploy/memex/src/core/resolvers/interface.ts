/**
 * Resolver — turns a raw textual reference into a canonical document /
 * entity identity.
 *
 * Examples:
 *   - `[[Home Assistant]]` (wikilink) → `doc_<id>` if a vault note has
 *     that title, else fallback to entity-only.
 *   - `/vault/foo.md` (path) → the document matching that source_path.
 *   - `YYYY-MM-DD` (date) → all documents whose frontmatter or body
 *     mentions that date.
 *
 * Resolvers are registered in `registry.ts`. ships only the
 * interface + registry shell; 's `reconcile-links` command
 * actually wires up the wikilink + path resolvers.
 */

export type ResolverKind = "wikilink" | "path" | "date" | "tag";

export interface ResolveContext {
  /** Engine for SQL probes. */
  engine: import("../engine/interface.ts").Engine;
}

export interface ResolveResult {
  documentId: string | null;
  /** Optional richer hit (path / title / score). */
  detail?: Record<string, unknown>;
}

export interface Resolver {
  readonly kind: ResolverKind;
  resolve(input: string, ctx: ResolveContext): Promise<ResolveResult>;
}
