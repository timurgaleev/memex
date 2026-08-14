/**
 * Graph signals — adjacency hub boost + session diversification.
 * Offline: the adjacency query is injected (no DB), so these assert the
 * pure scoring + grouping behaviour.
 */
import { describe, expect, it } from "bun:test";
import {
  applyGraphSignals,
  computeFloorThreshold,
  resolveGraphSignalsFloorRatio,
  GraphSignalsFloorParseError,
  sessionPrefix,
  slugForSourcePath,
  ADJACENCY_BOOST,
  CROSS_SOURCE_BOOST,
  SESSION_DEMOTE,
  type AdjacencyRow,
  type GraphSignalScorable,
} from "../src/core/search/graph-signals.ts";

const hit = (sourcePath: string, score: number): GraphSignalScorable => ({
  score,
  payload: { sourcePath },
});

// Engine is never touched when adjacencyFn is injected.
const noEngine = {} as never;

describe("slugForSourcePath", () => {
  it("strips the page:// scheme", () => {
    expect(slugForSourcePath("page://people/alice")).toBe("people/alice");
  });
  it("passes a file path through unchanged", () => {
    expect(slugForSourcePath("vault/notes/foo.md")).toBe("vault/notes/foo.md");
  });
});

describe("sessionPrefix", () => {
  it("detects a chat marker", () => {
    expect(sessionPrefix("media/chat/2026-05-20-foo/chunk-001")).toBe(
      "media/chat/2026-05-20-foo",
    );
  });
  it("detects a date segment", () => {
    expect(sessionPrefix("daily/2026-05-20/journal-1")).toBe("daily/2026-05-20");
  });
  it("returns null for an entity directory (never diversified)", () => {
    expect(sessionPrefix("people/alice")).toBeNull();
    expect(sessionPrefix("docs/quickstart")).toBeNull();
  });
  it("returns null for a slug with no path separator", () => {
    expect(sessionPrefix("alice")).toBeNull();
  });
});

describe("applyGraphSignals", () => {
  it("is a no-op when disabled", async () => {
    const hits = [hit("page://a", 1), hit("page://b", 0.5)];
    await applyGraphSignals(hits, noEngine, {
      enabled: false,
      adjacencyFn: async () => new Map(),
    });
    expect(hits.map((h) => h.score)).toEqual([1, 0.5]);
  });

  it("boosts a hub linked-to by >=2 in-set pages", async () => {
    const hits = [hit("page://hub", 1), hit("page://x", 0.9), hit("page://y", 0.8)];
    const adj = new Map<string, AdjacencyRow>([
      ["hub", { hits: 2, cross_source_hits: 0 }],
    ]);
    await applyGraphSignals(hits, noEngine, {
      enabled: true,
      adjacencyFn: async () => adj,
    });
    expect(hits[0]!.score).toBeCloseTo(ADJACENCY_BOOST, 10);
    expect(hits[1]!.score).toBe(0.9);
    expect(hits[2]!.score).toBe(0.8);
  });

  it("does not boost below the adjacency minimum (1 inbound link)", async () => {
    const hits = [hit("page://lonely", 1)];
    const adj = new Map<string, AdjacencyRow>([
      ["lonely", { hits: 1, cross_source_hits: 0 }],
    ]);
    await applyGraphSignals(hits, noEngine, {
      enabled: true,
      adjacencyFn: async () => adj,
    });
    expect(hits[0]!.score).toBe(1);
  });

  it("applies the cross-source boost (dormant arm — injected row)", async () => {
    const hits = [hit("page://hub", 1)];
    const adj = new Map<string, AdjacencyRow>([
      ["hub", { hits: 1, cross_source_hits: 2 }],
    ]);
    await applyGraphSignals(hits, noEngine, {
      enabled: true,
      adjacencyFn: async () => adj,
    });
    // hits < ADJACENCY_MIN_HITS → no adjacency boost; cross-source fires alone.
    expect(hits[0]!.score).toBeCloseTo(CROSS_SOURCE_BOOST, 10);
  });

  it("stacks adjacency and cross-source boosts when both fire", async () => {
    const hits = [hit("page://hub", 1)];
    const adj = new Map<string, AdjacencyRow>([
      ["hub", { hits: 2, cross_source_hits: 2 }],
    ]);
    await applyGraphSignals(hits, noEngine, {
      enabled: true,
      adjacencyFn: async () => adj,
    });
    expect(hits[0]!.score).toBeCloseTo(ADJACENCY_BOOST * CROSS_SOURCE_BOOST, 10);
  });

  it("boosts only the top chunk of a multi-chunk hub page", async () => {
    // Two chunks of the SAME page (same slug) — only the representative
    // (highest-scoring) is boosted, never both.
    const hits = [hit("page://hub", 1.0), hit("page://hub", 0.7)];
    const adj = new Map<string, AdjacencyRow>([
      ["hub", { hits: 2, cross_source_hits: 0 }],
    ]);
    await applyGraphSignals(hits, noEngine, {
      enabled: true,
      adjacencyFn: async () => adj,
    });
    expect(hits[0]!.score).toBeCloseTo(ADJACENCY_BOOST, 10);
    expect(hits[1]!.score).toBe(0.7); // sibling chunk untouched
  });

  it("demotes all but the top member of a session group", async () => {
    const hits = [
      hit("page://chat/s1/turn-1", 1.0),
      hit("page://chat/s1/turn-2", 0.9),
      hit("page://chat/s1/turn-3", 0.8),
    ];
    await applyGraphSignals(hits, noEngine, {
      enabled: true,
      adjacencyFn: async () => new Map(),
    });
    expect(hits[0]!.score).toBe(1.0); // representative kept
    expect(hits[1]!.score).toBeCloseTo(0.9 * SESSION_DEMOTE, 10);
    expect(hits[2]!.score).toBeCloseTo(0.8 * SESSION_DEMOTE, 10);
  });

  it("does not diversify distinct entity pages sharing a parent dir", async () => {
    const hits = [hit("page://people/alice", 1), hit("page://people/bob", 0.9)];
    await applyGraphSignals(hits, noEngine, {
      enabled: true,
      adjacencyFn: async () => new Map(),
    });
    expect(hits.map((h) => h.score)).toEqual([1, 0.9]);
  });

  it("fails open when the adjacency query throws", async () => {
    const hits = [hit("page://a", 1), hit("page://b", 0.5)];
    let errored = false;
    await applyGraphSignals(hits, noEngine, {
      enabled: true,
      adjacencyFn: async () => {
        throw new Error("db down");
      },
      onMeta: (m) => {
        errored = m.errored;
      },
    });
    expect(hits.map((h) => h.score)).toEqual([1, 0.5]);
    expect(errored).toBe(true);
  });

  it("skips boosts below the floor threshold", async () => {
    const hits = [hit("page://hub", 0.1)];
    const adj = new Map<string, AdjacencyRow>([
      ["hub", { hits: 5, cross_source_hits: 0 }],
    ]);
    await applyGraphSignals(hits, noEngine, {
      enabled: true,
      floorThreshold: 0.5,
      adjacencyFn: async () => adj,
    });
    expect(hits[0]!.score).toBe(0.1); // below floor → no boost
  });

  it("does NOT session-demote a hit below the floor", async () => {
    // Two hits in one session group; ratio 0.5 over top score 1.0 → floor 0.5.
    // The 0.4 member is below the floor and must keep its score (exempt from the
    // demotion, same as it is exempt from the boost loop).
    const hits = [
      hit("page://daily/2026-05-20/a", 1.0),
      hit("page://daily/2026-05-20/b", 0.4),
    ];
    const floorThreshold = computeFloorThreshold(hits, resolveGraphSignalsFloorRatio("0.5"));
    await applyGraphSignals(hits, noEngine, {
      enabled: true,
      floorThreshold,
      adjacencyFn: async () => new Map(),
    });
    expect(hits[0]!.score).toBe(1.0); // group top → kept
    expect(hits[1]!.score).toBe(0.4); // below floor → NOT demoted
  });

  it("DOES session-demote a below-top hit that is above the floor", async () => {
    // Both members above the floor (ratio 0) → the non-top member is demoted.
    const hits = [
      hit("page://daily/2026-05-20/a", 1.0),
      hit("page://daily/2026-05-20/b", 0.8),
    ];
    await applyGraphSignals(hits, noEngine, {
      enabled: true,
      floorThreshold: computeFloorThreshold(hits, resolveGraphSignalsFloorRatio("0")),
      adjacencyFn: async () => new Map(),
    });
    expect(hits[0]!.score).toBe(1.0);
    expect(hits[1]!.score).toBeCloseTo(0.8 * SESSION_DEMOTE, 10);
  });

  it("applies the boost to a hit AT the computed floor (end-to-end wiring)", async () => {
    // top score 1.0, ratio 0.5 → floor 0.5; the 0.5 hit is eligible, 0.4 is not.
    const hits = [hit("page://hub", 1.0), hit("page://mid", 0.5), hit("page://low", 0.4)];
    const adj = new Map<string, AdjacencyRow>([
      ["mid", { hits: 5, cross_source_hits: 0 }],
      ["low", { hits: 5, cross_source_hits: 0 }],
    ]);
    const floorThreshold = computeFloorThreshold(hits, resolveGraphSignalsFloorRatio("0.5"));
    expect(floorThreshold).toBe(0.5);
    await applyGraphSignals(hits, noEngine, {
      enabled: true,
      floorThreshold,
      adjacencyFn: async () => adj,
    });
    expect(hits[1]!.score).toBe(0.5 * ADJACENCY_BOOST); // at floor → boosted
    expect(hits[2]!.score).toBe(0.4); // below floor → untouched
  });
});

describe("computeFloorThreshold", () => {
  const set = [{ score: 1.0 }, { score: 0.4 }];
  it("returns -Infinity (gate off) when the ratio is undefined", () => {
    expect(computeFloorThreshold(set, undefined)).toBe(Number.NEGATIVE_INFINITY);
  });
  it("returns topScore * ratio", () => {
    expect(computeFloorThreshold(set, 0.5)).toBe(0.5);
    expect(computeFloorThreshold(set, 0.25)).toBe(0.25);
  });
  it("ratio 0 collapses the floor to 0 (effectively no gate for non-negative scores)", () => {
    expect(computeFloorThreshold(set, 0)).toBe(0);
  });
  it("returns -Infinity for an out-of-range ratio", () => {
    expect(computeFloorThreshold(set, 1.5)).toBe(Number.NEGATIVE_INFINITY);
    expect(computeFloorThreshold(set, -0.1)).toBe(Number.NEGATIVE_INFINITY);
  });
  it("returns -Infinity when the top score is non-positive or the set is empty", () => {
    expect(computeFloorThreshold([{ score: 0 }, { score: -1 }], 0.5)).toBe(
      Number.NEGATIVE_INFINITY,
    );
    expect(computeFloorThreshold([], 0.5)).toBe(Number.NEGATIVE_INFINITY);
  });
});

describe("resolveGraphSignalsFloorRatio", () => {
  it("returns undefined when unset or blank", () => {
    expect(resolveGraphSignalsFloorRatio(undefined)).toBeUndefined();
    expect(resolveGraphSignalsFloorRatio("")).toBeUndefined();
    expect(resolveGraphSignalsFloorRatio("   ")).toBeUndefined();
  });
  it("parses a valid ratio in [0, 1]", () => {
    expect(resolveGraphSignalsFloorRatio("0")).toBe(0);
    expect(resolveGraphSignalsFloorRatio("0.7")).toBe(0.7);
    expect(resolveGraphSignalsFloorRatio("1")).toBe(1);
  });
  it("fails loud on a non-numeric value", () => {
    expect(() => resolveGraphSignalsFloorRatio("abc")).toThrow(GraphSignalsFloorParseError);
  });
  it("fails loud on an out-of-range value", () => {
    expect(() => resolveGraphSignalsFloorRatio("1.5")).toThrow(GraphSignalsFloorParseError);
    expect(() => resolveGraphSignalsFloorRatio("-0.1")).toThrow(GraphSignalsFloorParseError);
  });
});
