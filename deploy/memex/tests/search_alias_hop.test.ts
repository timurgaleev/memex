/**
 * Alias-hop — boost the canonical page when an exact-alias query already
 * retrieved it, or inject it at top-of-organic + ε when absent; collisions
 * (one alias claimed by several pages) surface every claimant up to a cap.
 * Offline: the candidate lookup + page-head fetch are injected (no DB).
 */
import { describe, expect, it } from "bun:test";
import {
  applyAliasHop,
  aliasHopEnabled,
  ALIAS_HOP_PRESENT_BOOST,
  MAX_ALIAS_INJECT,
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
const candidates = (
  refs: Array<{ slug: string; source_id: string }>,
): AliasHopOpts["resolveCandidates"] => async () => refs;
const fetchHead =
  (): AliasHopOpts["fetchHead"] =>
  async (slug) => ({ ...hit(`page://${slug}`, 0) });

describe("aliasHopEnabled", () => {
  it("is ON by default, OFF when MEMEX_ALIAS_HOP=0", () => {
    delete process.env["MEMEX_ALIAS_HOP"];
    expect(aliasHopEnabled()).toBe(true);
    process.env["MEMEX_ALIAS_HOP"] = "0";
    expect(aliasHopEnabled()).toBe(false);
    delete process.env["MEMEX_ALIAS_HOP"];
  });
});

describe("applyAliasHop", () => {
  it("is a no-op for an empty query", async () => {
    const hits = [hit("page://a", 1)];
    expect(await applyAliasHop(hits, noStorage, "  ", "topic", undefined, { resolveCandidates: candidates([{ slug: "x", source_id: "default" }]) })).toBe(hits);
  });

  it("is a no-op past the token cap (an alias is a name, not prose)", async () => {
    let called = false;
    const hits = [hit("page://a", 1)];
    const out = await applyAliasHop(hits, noStorage, "one two three four five six seven", "topic", undefined, {
      resolveCandidates: async () => { called = true; return []; },
    });
    expect(called).toBe(false);
    expect(out).toBe(hits);
  });

  it("is a no-op when no page declares the alias", async () => {
    const hits = [hit("page://a", 1)];
    expect(await applyAliasHop(hits, noStorage, "bobby", "topic", undefined, { resolveCandidates: candidates([]) })).toBe(hits);
  });

  it("boosts the canonical page ×1.10 when present, then re-sorts", async () => {
    const hits = [hit("page://a", 1.0), hit("page://people/bob", 0.95)];
    const out = await applyAliasHop(hits, noStorage, "bobby", "topic", undefined, {
      resolveCandidates: candidates([{ slug: "people/bob", source_id: "default" }]),
    });
    expect(out[0]!.sourcePath).toBe("page://people/bob");
    expect(out[0]!.score).toBeCloseTo(0.95 * ALIAS_HOP_PRESENT_BOOST, 10);
    expect(out[0]!.evidence).toBe("alias_hit");
  });

  it("injects an absent canonical page at top-of-organic + ε (not an absolute/boosted score)", async () => {
    const hits = [hit("page://a", 1.0), hit("page://b", 0.8)];
    const out = await applyAliasHop(hits, noStorage, "bobby", "topic", undefined, {
      resolveCandidates: candidates([{ slug: "people/bob", source_id: "default" }]),
      fetchHead: fetchHead(),
    });
    expect(out.length).toBe(3);
    expect(out[0]!.sourcePath).toBe("page://people/bob");
    expect(out[0]!.score).toBeCloseTo(1.0 + 1e-6, 9); // top-of-organic + ε, NOT 1.0×1.10
    expect(out[0]!.evidence).toBe("alias_hit");
  });

  it("surfaces every collision claimant, deterministically ordered and capped", async () => {
    const hits = [hit("page://a", 1.0)];
    const refs = [
      { slug: "z/last", source_id: "default" },
      { slug: "a/first", source_id: "default" },
      { slug: "m/mid", source_id: "default" },
      { slug: "n/over-cap", source_id: "default" },
    ];
    const out = await applyAliasHop(hits, noStorage, "standup", "topic", undefined, {
      resolveCandidates: candidates(refs),
      fetchHead: fetchHead(),
    });
    // 3 injected (capped at MAX_ALIAS_INJECT) + the 1 original.
    expect(out.length).toBe(1 + MAX_ALIAS_INJECT);
    const injectedSlugs = out
      .map((h) => h.sourcePath)
      .filter((p) => p.startsWith("page://") && p !== "page://a");
    // ordered by slug (a/first, m/mid, z/last) → ε makes the last-injected
    // highest, so the final score-sort reverses to z, m, a above the organic top.
    expect(injectedSlugs).toContain("page://a/first");
    expect(injectedSlugs).toContain("page://m/mid");
    expect(injectedSlugs).toContain("page://z/last");
    expect(injectedSlugs).not.toContain("page://n/over-cap");
  });

  it("skips a candidate with no fetchable head chunk", async () => {
    const hits = [hit("page://a", 1.0)];
    const out = await applyAliasHop(hits, noStorage, "bobby", "topic", undefined, {
      resolveCandidates: candidates([{ slug: "people/bob", source_id: "default" }]),
      fetchHead: async () => null,
    });
    expect(out.length).toBe(1);
    expect(out[0]!.sourcePath).toBe("page://a");
  });
});
