/**
 * Resolvers public surface.
 */
export type {
  Resolver,
  ResolverKind,
  ResolveContext,
  ResolveResult,
} from "./interface.ts";
export {
  registerResolver,
  getResolver,
  listResolvers,
} from "./registry.ts";
export { wikilinkResolver } from "./builtin/wikilink.ts";
export { pathResolver } from "./builtin/path.ts";
