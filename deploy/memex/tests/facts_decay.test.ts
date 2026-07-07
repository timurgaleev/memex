/**
 * Fact confidence decay (migration 037 consumer) -- pure function + the
 * listFacts / entityRecall integration that applies it.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { entityRecall, listFacts } from "../src/core/facts.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";
import {
  HALFLIFE_DAYS,
  effectiveConfidence,
  factDecayEnabled,
  parseFactDate,
  type DecayableFact,
} from "../src/core/facts-decay.ts";

const DAY = 86_400_000;
const isoDate = (msAgo: number): string =>
  new Date(Date.now() - msAgo).toISOString().slice(0, 10);

function fact(over: Partial<DecayableFact> = {}): DecayableFact {
  return {
    confidence: 1,
    kind: null,
    valid_from: null,
    valid_until: null,
    written_at: new Date().toISOString(),
    ...over,
  };
}

// ---------------------------------------------------------------------------
// pure function
// ---------------------------------------------------------------------------

describe("HALFLIFE_DAYS", () => {
  it("pins the per-kind table", () => {
    expect(HALFLIFE_DAYS).toEqual({
      event: 7,
      commitment: 90,
      preference: 90,
      belief: 365,
      fact: 365,
    });
  });
});

describe("effectiveConfidence", () => {
  const now = new Date("2026-06-13T00:00:00Z");

  it("does not decay a fact with no recognized kind", () => {
    const old = fact({
      kind: null,
      confidence: 0.8,
      written_at: "2000-01-01T00:00:00Z",
    });
    expect(effectiveConfidence(old, now)).toBeCloseTo(0.8, 10);
  });

  it("decays to ~0.368 of confidence at exactly one half-life", () => {
    const f = fact({
      kind: "event",
      confidence: 1,
      valid_from: new Date(now.getTime() - 7 * DAY).toISOString().slice(0, 10),
    });
    expect(effectiveConfidence(f, now)).toBeCloseTo(Math.exp(-1), 3);
  });

  it("uses the kind-specific half-life (fact = 365d)", () => {
    const f = fact({
      kind: "fact",
      confidence: 1,
      valid_from: new Date(now.getTime() - 365 * DAY)
        .toISOString()
        .slice(0, 10),
    });
    expect(effectiveConfidence(f, now)).toBeCloseTo(Math.exp(-1), 3);
  });

  it("zeroes a fact past its valid_until regardless of kind/confidence", () => {
    const expired = fact({
      kind: null,
      confidence: 1,
      valid_until: "2026-06-12",
    });
    expect(effectiveConfidence(expired, now)).toBe(0);
  });

  it("does not cut a fact whose valid_until is in the future", () => {
    const f = fact({ kind: null, confidence: 0.9, valid_until: "2999-01-01" });
    expect(effectiveConfidence(f, now)).toBeCloseTo(0.9, 10);
  });

  it("falls back to written_at when valid_from is null", () => {
    const f = fact({
      kind: "event",
      confidence: 1,
      valid_from: null,
      written_at: new Date(now.getTime() - 7 * DAY).toISOString(),
    });
    expect(effectiveConfidence(f, now)).toBeCloseTo(Math.exp(-1), 3);
  });

  it("treats a future anchor as un-aged", () => {
    const f = fact({
      kind: "event",
      confidence: 0.5,
      valid_from: "2999-01-01",
    });
    expect(effectiveConfidence(f, now)).toBeCloseTo(0.5, 10);
  });

  it("clamps confidence into [0, 1] and maps NaN to 0", () => {
    expect(effectiveConfidence(fact({ kind: null, confidence: 5 }), now)).toBe(
      1,
    );
    expect(effectiveConfidence(fact({ kind: null, confidence: -1 }), now)).toBe(
      0,
    );
    expect(effectiveConfidence(fact({ kind: null, confidence: NaN }), now)).toBe(
      0,
    );
  });
});

describe("parseFactDate", () => {
  it("parses a bare DATE as UTC midnight", () => {
    expect(parseFactDate("2026-06-13")?.toISOString()).toBe(
      "2026-06-13T00:00:00.000Z",
    );
  });
  it("parses Postgres timestamptz text (space + `+00` offset)", () => {
    expect(parseFactDate("2026-06-13 12:00:00+00")?.getTime()).toBe(
      Date.parse("2026-06-13T12:00:00Z"),
    );
  });
  it("parses a `+00:00` offset and an ISO `Z`", () => {
    expect(parseFactDate("2026-06-13 12:00:00+00:00")?.getTime()).toBe(
      Date.parse("2026-06-13T12:00:00Z"),
    );
    expect(parseFactDate("2026-06-13T09:30:00Z")?.getTime()).toBe(
      Date.parse("2026-06-13T09:30:00Z"),
    );
  });
  it("returns null for null/empty/garbage", () => {
    expect(parseFactDate(null)).toBeNull();
    expect(parseFactDate("")).toBeNull();
    expect(parseFactDate("not-a-date")).toBeNull();
  });
  it("rejects an invalid calendar date instead of rolling it over", () => {
    // 2026-02-31 / 2026-13-01 would silently roll into the next month in `Date`.
    expect(parseFactDate("2026-02-31")).toBeNull();
    expect(parseFactDate("2026-13-01")).toBeNull();
    expect(parseFactDate("2026-00-10")).toBeNull();
    // a real leap day still parses.
    expect(parseFactDate("2024-02-29")?.toISOString()).toBe(
      "2024-02-29T00:00:00.000Z",
    );
  });
});

describe("factDecayEnabled", () => {
  it("defaults ON; MEMEX_FACT_DECAY=0 opts out", () => {
    const prev = process.env.MEMEX_FACT_DECAY;
    process.env.MEMEX_FACT_DECAY = "1";
    expect(factDecayEnabled()).toBe(true);
    delete process.env.MEMEX_FACT_DECAY;
    expect(factDecayEnabled()).toBe(true);
    process.env.MEMEX_FACT_DECAY = "0";
    expect(factDecayEnabled()).toBe(false);
    if (prev !== undefined) process.env.MEMEX_FACT_DECAY = prev;
    else delete process.env.MEMEX_FACT_DECAY;
  });
});

// ---------------------------------------------------------------------------
// listFacts / entityRecall integration
// ---------------------------------------------------------------------------

describe("listFacts decay integration", () => {
  let tmp: string;
  let storage: Storage;

  async function insertFact(p: {
    fact: string;
    confidence: number;
    kind?: string | null;
    valid_from?: string | null;
    valid_until?: string | null;
  }): Promise<void> {
    await storage
      .engine()
      .query(
        `INSERT INTO entity_facts
           (entity_slug, fact, confidence, kind, valid_from, valid_until, visibility)
         VALUES ('people/alice', $1, $2, $3, $4, $5, 'world')`,
        [
          p.fact,
          p.confidence,
          p.kind ?? null,
          p.valid_from ?? null,
          p.valid_until ?? null,
        ],
      );
  }

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "memex-decay-"));
    storage = new Storage({ dbPath: join(tmp, "db") });
    await storage.init();
    // old: high raw confidence but ~2 half-lives stale -> decays low.
    await insertFact({
      fact: "old-fact",
      confidence: 0.9,
      kind: "fact",
      valid_from: isoDate(2 * 365 * DAY),
    });
    // fresh: lower raw confidence, no decay -> stays 0.6.
    await insertFact({
      fact: "fresh-fact",
      confidence: 0.6,
      kind: "fact",
      valid_from: isoDate(0),
    });
    // expired: top raw confidence but past valid_until -> dropped under decay.
    await insertFact({
      fact: "expired-event",
      confidence: 1,
      kind: "event",
      valid_until: isoDate(1 * DAY),
    });
  });

  afterEach(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("decays by default (internal default is ON)", async () => {
    const rows = await listFacts(storage, "people/alice");
    expect(rows.map((r) => r.fact)).toEqual(["fresh-fact", "old-fact"]);
  });

  it("orders by raw confidence with MEMEX_FACT_DECAY=0 (opt-out)", async () => {
    const prev = process.env.MEMEX_FACT_DECAY;
    process.env.MEMEX_FACT_DECAY = "0";
    try {
      const rows = await listFacts(storage, "people/alice");
      expect(rows.map((r) => r.fact)).toEqual([
        "expired-event",
        "old-fact",
        "fresh-fact",
      ]);
    } finally {
      if (prev === undefined) delete process.env.MEMEX_FACT_DECAY;
      else process.env.MEMEX_FACT_DECAY = prev;
    }
  });

  it("re-ranks by effective confidence and drops expired with decay ON", async () => {
    const rows = await listFacts(storage, "people/alice", { decay: true });
    // expired-event is gone; fresh (0.6) now outranks the decayed old (~0.12).
    expect(rows.map((r) => r.fact)).toEqual(["fresh-fact", "old-fact"]);
  });

  it("ignores decay for an explicit recency order", async () => {
    const rows = await listFacts(storage, "people/alice", {
      decay: true,
      order: "recency",
    });
    // recency wins: all three present (expired not dropped), newest first.
    expect(rows).toHaveLength(3);
  });

  it("projects the mig037 metadata columns", async () => {
    const rows = await listFacts(storage, "people/alice");
    const fresh = rows.find((r) => r.fact === "fresh-fact")!;
    expect(fresh.kind).toBe("fact");
    expect(fresh.valid_from).toBe(isoDate(0));
    expect(fresh.valid_until).toBeNull();
  });

  it("entityRecall honors an explicit decay flag", async () => {
    const off = await entityRecall(storage, "people/alice", { decay: false });
    expect(off.facts.map((f) => f.fact)).toEqual([
      "expired-event",
      "old-fact",
      "fresh-fact",
    ]);
    const on = await entityRecall(storage, "people/alice", { decay: true });
    expect(on.facts.map((f) => f.fact)).toEqual(["fresh-fact", "old-fact"]);
  });

  it("entityRecall defaults decay from MEMEX_FACT_DECAY", async () => {
    const prev = process.env.MEMEX_FACT_DECAY;
    process.env.MEMEX_FACT_DECAY = "1";
    try {
      const r = await entityRecall(storage, "people/alice");
      expect(r.facts.map((f) => f.fact)).toEqual(["fresh-fact", "old-fact"]);
    } finally {
      if (prev === undefined) delete process.env.MEMEX_FACT_DECAY;
      else process.env.MEMEX_FACT_DECAY = prev;
    }
  });

  // Oracle gate: with decay globally ON, the PUBLIC (redacted) ingress must NOT
  // apply decay -- otherwise a caller could diff the decayed order against
  // `order:"recency"` to infer which hidden fact expired/demoted by metadata
  // they cannot see. Internal ingress still decays.
  it("forces decay OFF on the public bearer path, ON internally", async () => {
    const prev = process.env.MEMEX_FACT_DECAY;
    process.env.MEMEX_FACT_DECAY = "1";
    try {
      const pub = await dispatchTool(
        storage,
        { name: "entity_facts", arguments: { entity_slug: "people/alice" } },
        { isPublic: true },
      );
      const pubFacts = JSON.parse(pub.content[0].text).facts as Record<
        string,
        unknown
      >[];
      // Raw confidence order (decay NOT applied): expired-event survives, first.
      expect(pubFacts.map((f) => f.id)).toHaveLength(3);
      expect(pubFacts[0].confidence).toBe(1);
      // Fact text is redacted on public ingress.
      expect(pubFacts[0].fact).toBeUndefined();

      const internal = await dispatchTool(
        storage,
        { name: "entity_facts", arguments: { entity_slug: "people/alice" } },
        { isPublic: false },
      );
      const intFacts = JSON.parse(internal.content[0].text).facts as Record<
        string,
        unknown
      >[];
      // Decay applied internally: expired dropped, fresh outranks decayed-old.
      expect(intFacts.map((f) => f.fact)).toEqual(["fresh-fact", "old-fact"]);
    } finally {
      if (prev === undefined) delete process.env.MEMEX_FACT_DECAY;
      else process.env.MEMEX_FACT_DECAY = prev;
    }
  });
});
