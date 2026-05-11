/**
 * Path resolver — `/vault/foo.md` → document with that source_path.
 * stub; wires it.
 */
import type { Resolver, ResolveContext, ResolveResult } from "../interface.ts";

export const pathResolver: Resolver = {
  kind: "path",
  async resolve(_input: string, _ctx: ResolveContext): Promise<ResolveResult> {
    return { documentId: null };
  },
};
