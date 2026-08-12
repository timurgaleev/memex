/**
 * Push bench — replays the shipped corpus through the real volunteer path and
 * pins today's scores.
 *
 * MEASURES: whether the injection decision still behaves the way a human
 * labelled it. Precision, recall, miss rate and false-fire rate over 18
 * labelled turns; which turns miss and which stay silent; and — the part that
 * keeps the silence numbers honest — how far each quiet turn actually got
 * before deciding to say nothing.
 *
 * The pinned numbers are a RATCHET, not a target. A failure here is a report
 * that the brain now volunteers differently, and the per-turn assertions below
 * say which turn moved and in which direction. Two turns are pinned as KNOWN
 * MISSES (`extraction-blind-spots`): fixing them is expected to break this test,
 * and the fix is to update the pin, not the label.
 *
 * Hermetic: PGLite on a temp dir, no network, no model calls, no clock or
 * random dependence.
 *
 * What a green run does NOT tell you: that the push reflex is USEFUL. The
 * corpus is six hand-written conversations against six hand-written miniature
 * brains, with the window boundary handed to the harness rather than
 * discovered. It cannot see whether a volunteered page helped the answer that
 * followed, and it cannot see a failure mode nobody thought to write down.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { loadCorpus, parseFixture, FixtureError } from "../src/core/bench/fixtures.ts";
import {
  runCorpus,
  runFixture,
  resetBrain,
  seedFixture,
  type BenchTurnOutcome,
  type CorpusRun,
} from "../src/core/bench/harness.ts";
import { scorePush, formatScores } from "../src/core/bench/push-metrics.ts";
import type { PushFixture } from "../src/core/bench/fixtures.ts";

let tmp: string;
let storage: Storage;
let fixtures: PushFixture[];
let run: CorpusRun;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-push-bench-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  fixtures = loadCorpus();
  // One Storage, one replay of the whole corpus; every test below reads it.
  run = await runCorpus(storage, fixtures);
});

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

const turnById = (id: string): BenchTurnOutcome => {
  const t = run.turns.find((x) => x.id === id);
  if (!t) throw new Error(`no such bench turn: ${id}`);
  return t;
};

// -- The loader is strict, or the labels mean nothing ----------------------

describe("fixtures loader", () => {
  const minimal = {
    name: "x",
    description: "d",
    pages: [{ slug: "people/a", type: "person", title: "A", body: "b" }],
    turns: [{ role: "user", text: "hi", gold: [] }],
  };

  it("accepts a minimal well-formed fixture", () => {
    expect(parseFixture("t", structuredClone(minimal)).turns[0]!.gold).toEqual([]);
  });

  it("rejects an unknown key on a turn — the silent-typo case", () => {
    const bad = structuredClone(minimal) as Record<string, unknown>;
    (bad["turns"] as Record<string, unknown>[])[0] = {
      role: "user",
      text: "hi",
      gold: [],
      glod: ["people/a"],
    };
    expect(() => parseFixture("t", bad)).toThrow(FixtureError);
    expect(() => parseFixture("t", bad)).toThrow(/unknown key "glod"/);
  });

  it("rejects an unknown key at the top level and on a page", () => {
    const badTop = { ...structuredClone(minimal), windowSize: 4 };
    expect(() => parseFixture("t", badTop)).toThrow(/unknown key "windowSize"/);
    const badPage = structuredClone(minimal) as Record<string, unknown>;
    (badPage["pages"] as Record<string, unknown>[])[0]!["alias"] = ["A"];
    expect(() => parseFixture("t", badPage)).toThrow(/unknown key "alias"/);
  });

  it("rejects a turn with no gold key — absent must not read as silent", () => {
    const bad = structuredClone(minimal) as Record<string, unknown>;
    (bad["turns"] as Record<string, unknown>[])[0] = { role: "user", text: "hi" };
    expect(() => parseFixture("t", bad)).toThrow(/missing/);
  });

  it("rejects a label naming a slug the fixture never seeds", () => {
    const bad = structuredClone(minimal) as Record<string, unknown>;
    (bad["turns"] as Record<string, unknown>[])[0] = {
      role: "user",
      text: "hi",
      gold: ["people/typo"],
    };
    expect(() => parseFixture("t", bad)).toThrow(/not a seeded page/);
  });

  it("rejects a gold slug outside the fixture's own read scope", () => {
    const bad = structuredClone(minimal) as Record<string, unknown>;
    (bad["pages"] as Record<string, unknown>[])[0]!["source"] = "tenant-b";
    bad["sourceIds"] = ["tenant-a"];
    (bad["turns"] as Record<string, unknown>[])[0] = {
      role: "user",
      text: "hi",
      gold: ["people/a"],
    };
    expect(() => parseFixture("t", bad)).toThrow(/outside the fixture's sourceIds/);
  });

  it("rejects an unknown page type and a bad role", () => {
    const badType = structuredClone(minimal) as Record<string, unknown>;
    (badType["pages"] as Record<string, unknown>[])[0]!["type"] = "persson";
    expect(() => parseFixture("t", badType)).toThrow(/not a known page type/);
    const badRole = structuredClone(minimal) as Record<string, unknown>;
    (badRole["turns"] as Record<string, unknown>[])[0]!["role"] = "system";
    expect(() => parseFixture("t", badRole)).toThrow(/expected "user" or "assistant"/);
  });
});

// -- The corpus itself -----------------------------------------------------

describe("push bench corpus", () => {
  it("ships the cases the bench exists to cover", () => {
    expect(fixtures.map((f) => f.name)).toEqual([
      "alias-resolution",
      "exact-title-mention",
      "extraction-blind-spots",
      "silence-with-candidates",
      "source-scope",
      "window-followup",
    ]);
    expect(run.turns.length).toBe(18);
  });

  it("pins today's corpus scores", () => {
    const s = scorePush(run.scored);
    expect(s).toEqual({
      turns: 18,
      shouldSpeak: 15,
      shouldStaySilent: 3,
      precision: 1,
      recall: 0.8824,
      missRate: 0.1333,
      falseFireRate: 0,
    });
    // Kept as a readable line so a diff between two runs is one grep away.
    expect(formatScores("corpus", s)).toBe(
      "corpus: turns=18 speak=15 silent=3 precision=100.0% recall=88.2% " +
        "miss=13.3% false_fire=0.0%",
    );
  });

  it("pins per-fixture scores so a regression names its own fixture", () => {
    const actual = Object.fromEntries(
      run.runs.map((r) => {
        const s = scorePush(r.scored);
        return [r.fixture, [s.precision, s.recall, s.missRate, s.falseFireRate]];
      }),
    );
    expect(actual).toEqual({
      "alias-resolution": [1, 1, 0, null],
      "exact-title-mention": [1, 1, 0, null],
      "extraction-blind-spots": [1, 0.3333, 0.6667, null],
      "silence-with-candidates": [1, 1, 0, 0],
      "source-scope": [1, 1, 0, 0],
      // `null`, not 0: these fixtures have no silence turns at all, and
      // scorePush refuses to report a passing grade for a test never run.
      "window-followup": [1, 1, 0, null],
    });
  });

  it("volunteers nothing that was not wanted, anywhere in the corpus", () => {
    const noise = run.turns.flatMap((t) => {
      const wanted = new Set([...t.gold, ...t.acceptable]);
      return t.volunteered.filter((v) => !wanted.has(v.slug)).map((v) => `${t.id} -> ${v.slug}`);
    });
    expect(noise).toEqual([]);
  });
});

// -- The anti-proxy guard --------------------------------------------------
//
// A silent turn only measures the injection decision if the brain REACHED that
// decision. A turn with no entity candidates returns on volunteerContext's
// first guard, never resolves, never gates — and still counts as silence,
// flattering the false-fire rate under every configuration. These assertions
// make that degeneration fail the build instead of scoring well.
//
// `candidates` is measured over the WINDOW, not the turn's own text — that is
// what volunteerContext sees, so a turn whose own words carry no entity still
// reaches the decision if an earlier turn in the window named one. The guard
// therefore fires on the case that actually matters: a window with nothing in
// it at all.

describe("silence turns are earned, not accidental", () => {
  it("every silence turn produced entity candidates", () => {
    const silent = run.turns.filter((t) => t.gold.length === 0);
    expect(silent.length).toBe(3);
    const barren = silent.filter((t) => t.candidates.length === 0).map((t) => t.id);
    expect(barren).toEqual([]);
    for (const t of silent) expect(t.candidates.length).toBeGreaterThan(0);
  });

  it("at least one silence turn resolved real pages and declined them anyway", () => {
    const declined = run.turns.filter(
      (t) => t.gold.length === 0 && t.pointers.length > 0 && t.volunteered.length === 0,
    );
    expect(declined.map((t) => t.id)).toEqual([
      "silence-with-candidates#0",
      "silence-with-candidates#1",
    ]);
  });

  it("names the arm the gate rejected, so a gate change is legible", () => {
    const t = turnById("silence-with-candidates#0");
    // "Alice" is neither an alias nor the title of people/alice, so the only
    // arm left is slug-suffix: 0.60 + 0.05 salience = 0.65, under the 0.70 gate.
    expect(t.candidates).toEqual(["Alice"]);
    expect(t.pointers).toEqual([{ slug: "people/alice", arm: "slug-suffix" }]);
    expect(t.volunteered).toEqual([]);
  });

  it("keeps the silent fixture from being degenerately silent", () => {
    const spoke = run.runs
      .find((r) => r.fixture === "silence-with-candidates")!
      .turns.filter((t) => t.volunteered.length > 0);
    expect(spoke.map((t) => t.id)).toEqual(["silence-with-candidates#2"]);
  });
});

// -- Scope is a boundary, not an accident ----------------------------------

describe("source scope", () => {
  it("never volunteers the other tenant's page, however it is named", () => {
    const leaked = run.turns
      .flatMap((t) => t.volunteered.map((v) => `${t.id} -> ${v.slug}`))
      .filter((s) => s.includes("people/erin-kell"));
    expect(leaked).toEqual([]);
  });

  it("still resolves the in-scope page, so the silence is not a dead scope", () => {
    const r = run.runs.find((x) => x.fixture === "source-scope")!;
    expect(r.turns.map((t) => t.volunteered.map((v) => v.slug))).toEqual([
      [],
      ["people/mira-solberg"],
      ["people/mira-solberg"],
    ]);
  });
});

// -- Misses are named, not averaged away -----------------------------------

describe("known misses", () => {
  it("pins exactly which turns miss today", () => {
    const missed = run.turns
      .filter((t) => t.gold.length > 0)
      .filter((t) => {
        const wanted = new Set([...t.gold, ...t.acceptable]);
        return !t.volunteered.some((v) => wanted.has(v.slug));
      })
      .map((t) => t.id);
    expect(missed).toEqual(["extraction-blind-spots#0", "extraction-blind-spots#1"]);
  });

  it("records HOW each known miss fails, not just that it does", () => {
    // Lowercase: the extractor never even produced a candidate.
    expect(turnById("extraction-blind-spots#0").candidates).toEqual([]);
    // Sentence-opener glue: a candidate exists, but the capitalized run
    // swallowed the stopword in front of the name, so it resolves to nothing.
    expect(turnById("extraction-blind-spots#1").candidates).toContain("Did Dana");
    expect(turnById("extraction-blind-spots#1").pointers).toEqual([]);
    // Same page, same intent, phrased so the name stands alone: resolved.
    expect(turnById("extraction-blind-spots#2").volunteered.map((v) => v.slug)).toEqual([
      "people/dana-reed",
    ]);
  });
});

// -- The harness itself ----------------------------------------------------

describe("harness", () => {
  it("actually empties the brain between fixtures", async () => {
    // The reused-Storage test above compares the harness against itself, so a
    // no-op reset passes it — mutation testing proved that. The isolation has
    // to be asserted directly, or two fixtures that happen to be disjoint are
    // the only thing keeping the scores independent. Two already seed the same
    // person, so the next fixture wanting "this page does not exist" would be
    // silently contaminated.
    const fixture = fixtures[0]!;
    await seedFixture(storage, fixture);
    const before = await storage
      .engine()
      .query<{ n: string }>(`SELECT count(*)::text AS n FROM pages`);
    expect(Number(before.rows[0]!.n)).toBeGreaterThan(0);

    await resetBrain(storage);
    const after = await storage
      .engine()
      .query<{ n: string }>(`SELECT count(*)::text AS n FROM pages`);
    expect(after.rows[0]!.n).toBe("0");
  });

  it("replays a fixture identically on a reused Storage", async () => {
    const fixture = fixtures.find((f) => f.name === "source-scope")!;
    const again = await runFixture(storage, fixture);
    const before = run.runs.find((r) => r.fixture === "source-scope")!;
    expect(again.turns.map((t) => t.volunteered.map((v) => v.slug))).toEqual(
      before.turns.map((t) => t.volunteered.map((v) => v.slug)),
    );
  });

  it("grows the window to the fixture's limit and no further", () => {
    const sizes = run.runs
      .find((r) => r.fixture === "window-followup")!
      .turns.map((t) => t.windowSize);
    expect(sizes).toEqual([1, 2, 3]);
  });
});

/**
 * The scorer itself, on synthetic turns.
 *
 * The corpus pins precision=1 and false_fire=0 — which is exactly what a
 * BROKEN scorer emits too. Mutation testing proved it: counting every injected
 * slug as wanted, and never counting a false fire, both left the corpus test
 * green. A pin at the value a no-op produces verifies nothing.
 *
 * So the arithmetic is exercised here on turns built to make each number move.
 */
describe("scorePush arithmetic", () => {
  it("counts precision against what was actually wanted", () => {
    const s = scorePush([
      { id: "t1", gold: ["a"], injected: ["a", "junk"] },
      { id: "t2", gold: ["b"], injected: ["b"] },
    ]);
    // 2 wanted of 3 injected — a scorer that credits everything says 1.
    expect(s.precision).toBe(0.6667);
  });

  it("counts a false fire when the brain speaks on a silent turn", () => {
    const s = scorePush([
      { id: "q1", gold: [], injected: ["something"] },
      { id: "q2", gold: [], injected: [] },
      { id: "q3", gold: [], injected: [] },
    ]);
    // The metric that keeps the others honest has to be able to be non-zero.
    expect(s.falseFireRate).toBe(0.3333);
    expect(s.shouldStaySilent).toBe(3);
  });

  it("micro-averages recall, so a three-page turn weighs three times a one-page turn", () => {
    const s = scorePush([
      { id: "big", gold: ["a", "b", "c"], injected: ["a"] },
      { id: "small", gold: ["d"], injected: ["d"] },
    ]);
    // 2 of 4 gold slugs. A mean of per-turn rates would say 0.667.
    expect(s.recall).toBe(0.5);
  });

  it("lets an acceptable slug save precision but never claim recall", () => {
    const s = scorePush([
      { id: "t", gold: ["a"], acceptable: ["b"], injected: ["b"] },
    ]);
    expect(s.precision).toBe(1);
    expect(s.recall).toBe(0);
    // Something wanted did come back, so it is a recall shortfall, not a miss.
    expect(s.missRate).toBe(0);
  });

  it("counts a miss only when nothing wanted came back at all", () => {
    const s = scorePush([
      { id: "partial", gold: ["a", "b"], injected: ["a"] },
      { id: "empty", gold: ["c"], injected: [] },
    ]);
    // Partial coverage is already told by recall; counting it as a miss too
    // would report one failure twice.
    expect(s.missRate).toBe(0.5);
    expect(s.recall).toBe(0.3333);
  });

  it("reports an unmeasured rate as null, never as a passing zero", () => {
    const noSilence = scorePush([{ id: "t", gold: ["a"], injected: ["a"] }]);
    expect(noSilence.falseFireRate).toBeNull();
    const noSpeech = scorePush([{ id: "q", gold: [], injected: [] }]);
    expect(noSpeech.recall).toBeNull();
    expect(noSpeech.missRate).toBeNull();
    // "0% false fire" for a corpus with no silence cases would read as a pass
    // for an exam nobody sat.
    expect(formatScores("x", noSilence)).toContain("false_fire=n/a");
  });
});
