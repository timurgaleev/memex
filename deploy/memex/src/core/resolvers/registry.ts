/**
 * Resolver registry — pluggable lookup table keyed by ResolverKind.
 * has zero registered resolvers; 's reconcile-links and
 * pages commands populate the wikilink + path entries.
 */
import type { Resolver, ResolverKind } from "./interface.ts";

const REGISTRY = new Map<ResolverKind, Resolver>();

export function registerResolver(r: Resolver): void {
  REGISTRY.set(r.kind, r);
}

export function getResolver(kind: ResolverKind): Resolver | undefined {
  return REGISTRY.get(kind);
}

export function listResolvers(): Resolver[] {
  return Array.from(REGISTRY.values());
}
