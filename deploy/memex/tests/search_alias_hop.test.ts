/**
 * Alias-hop — boost the canonical page when an exact-alias query already
 * retrieved it, or inject it at the head when absent. Offline: the alias
 * resolver and page-head fetch are injected, so these assert the pure
 * boost/inject/gating behaviour with no DB.
 */
import { describe, expect, it } from "bun:test";
import {
  applyAliasHop,
  aliasHopEnabled,
  ALIAS_HOP_PRESENT_BOOST,
  type AliasHopOpts,
} from "../src/core/search/alias-hop.ts";
import type { SearchHit } from "../src/core/search/hybrid.ts";

const hit = (sourcePath: string, score: number): SearchHit => ({
  chunkId: `c:${sourcePath}`,
  documentId: `d:${sourcePath}`,
  sourcePath,
  title: null,
  content: "",
  score,
  intent: "topic",
});

const noStorage = {} as never;
const resolveTo = (slug: string | null): AliasHopOpts => ({
  resolveAlias: async () => slug,
});

describe("aliasHopEnabled", () => {
  it("is ON by default", () => {
    delete process.env["MEMEX_ALIAS_HOP"];
    expect(aliasHopEnabled()).toBe(true);
  });
  it("is OFF when MEMEX_ALIAS_HOP=0", () => {
    process.env["MEMEX_ALIAS_HOP"] = "0";
    expect(aliasHopEnabled()).toBe(false);
    delete process.env["MEMEX_ALIAS_HOP"];
  });
});

describe("applyAliasHop", () => {
  it("is a no-op for a non-indexable (empty) query", async () => {
    let called = false;
    const hits = [hit("page://a", 1)];
    const out = await applyAliasHop(hits, noStorage, "   ", "topic", undefined, {
      resolveAlias: async () => {
        called = true;
        return "x";
      },
    });
    expect(called).toBe(false);
    expect(out).toBe(hits);
  });

  it("is a no-op for a query longer than the token cap (an alias is a name)", async () => {
    let called = false;
    const hits = [hit("page://a", 1)];
    const out = await applyAliasHop(
      hits,
      noStorage,
      "one two three four five six seven",
      "topic",
      undefined,
      { resolveAlias: async () => { called = true; return "x"; } },
    );
    expect(called).toBe(false);
    expect(out).toBe(hits);
  });

  it("is a no-op on a resolve miss / collision (null)", async () => {
    const hits = [hit("page://a", 1)];
    const out = await applyAliasHop(hits, noStorage, "bobby", "topic", undefined, resolveTo(null));
    expect(out).toBe(hits);
  });

  it("boosts the canonical page when already present, then re-sorts", async () => {
    const hits = [hit("page://a", 1.0), hit("page://people/bob", 0.95)];
    const out = await applyAliasHop(hits, noStorage, "bobby", "topic", undefined, resolveTo("people/bob"));
    expect(out[0]!.sourcePath).toBe("page://people/bob"); // 0.95 * 1.1 = 1.045 → top
    expect(out[0]!.score).toBeCloseTo(0.95 * ALIAS_HOP_PRESENT_BOOST, 10);
    expect(out[1]!.sourcePath).toBe("page://a");
  });

  it("injects the canonical page at the head when absent", async () => {
    const hits = [hit("page://a", 1.0), hit("page://b", 0.8)];
    const injected = hit("page://people/bob", 0);
    const out = await applyAliasHop(hits, noStorage, "bobby", "topic", undefined, {
      resolveAlias: async () => "people/bob",
      fetchHead: async () => injected,
    });
    expect(out.length).toBe(3);
    expect(out[0]!.sourcePath).toBe("page://people/bob");
    expect(out[0]!.score).toBeCloseTo(1.0 * ALIAS_HOP_PRESENT_BOOST, 10); // top score × boost
  });

  it("is a no-op when the canonical page has no fetchable head chunk", async () => {
    const hits = [hit("page://a", 1.0)];
    const out = await applyAliasHop(hits, noStorage, "bobby", "topic", undefined, {
      resolveAlias: async () => "people/bob",
      fetchHead: async () => null,
    });
    expect(out).toBe(hits);
  });
});
