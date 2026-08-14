/**
 * Continuity bench — replays "one client writes, a different client asks
 * later" through the real dispatch path and pins today's scores.
 *
 * MEASURES: whether a decision written in session A comes back to a DIFFERENT
 * client in session B, and whether it stays away from clients that must not
 * see it. Continuity recall and leak rate are pinned together, because either
 * one alone is trivially gameable: a brain that answers every caller with
 * everything scores perfect recall, and a brain that answers nobody scores a
 * perfect leak rate.
 *
 * THE PINS ARE A RATCHET, NOT A TARGET. One probe is pinned as a KNOWN MISS
 * (`reader-volunteer-lowercase`): the same question in lowercase produces no
 * entity candidates at all, so the decision is never volunteered. Fixing the
 * extractor SHOULD break this test — update the pin, not the label.
 *
 * WHY A 0% LEAK RATE HERE IS NOT THE SAME AS A 0% LEAK RATE FROM A NO-OP.
 * "Nothing came back" is the answer an empty brain, a broken query and a
 * working fence all give. Three separate guards below stop that reading:
 * every negative probe is paired with a probe over the SAME op and args that
 * demonstrably returns the item; the public refusals are shown to be
 * load-bearing by calling dispatch directly without the ingress guard and
 * getting the slug; and the scorer is exercised on a synthetic leak so the
 * pinned zero is a measurement rather than a constant.
 *
 * Hermetic and free: PGLite on a temp dir, a deterministic embedder for both
 * the mirror and the query, and no model call anywhere — asserted by counting
 * `mcp_spend_log`, which `trackedInvoke` writes to even when a paid call FAILS.
 * Zero rows therefore means zero attempts, not merely zero dollars.
 *
 * What a green run does NOT tell you: that the fence holds over a real
 * transport. Two AuthInfos through one process is not two HTTP connections
 * with two bearer tokens, and only the tool denylist of the ingress layer is
 * exercised here. Nor does it grade redaction: a probe scores on which handles
 * came back, never on whether a body was stripped from them.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";
import { daySpendUsd } from "../src/core/budget.ts";
import { clearCache } from "../src/core/search/query-cache.ts";
import {
  loadContinuityCorpus,
  parseContinuityFixture,
  provenanceRequired,
  ContinuityFixtureError,
  type ContinuityFixture,
} from "../src/core/bench/continuity-fixtures.ts";
import {
  carriesProvenance,
  dispatchOptionsFor,
  runContinuityCorpus,
  toScoredProbe,
  type ContinuityCorpusRun,
  type ContinuityProbeOutcome,
} from "../src/core/bench/continuity-harness.ts";
import { assertBrainEmpty, resetBrain } from "../src/core/bench/reset.ts";
import { scorePush, formatScores, type ScoredTurn } from "../src/core/bench/push-metrics.ts";

let tmp: string;
let storage: Storage;
let fixtures: ContinuityFixture[];
let run: ContinuityCorpusRun;
let spendRowsBefore: number;
let spendRowsAfter: number;
let daySpendBefore: number;
let daySpendAfter: number;

/** Knobs that would turn a free path into a paid one, or move the fences the
 *  corpus grades. Cleared so the run measures the shipped defaults. */
const NEUTRALISED = [
  "MEMEX_SEARCH_MODE",
  "MEMEX_QUERY_EXPANSION",
  "MEMEX_RERANK",
  "MEMEX_GRAPH_RERANK",
  "MEMEX_CONTEXTUAL_LLM",
  "MEMEX_FACTS_DEDUP",
  "MEMEX_FACTS_DEDUP_LLM",
  "MEMEX_FACT_DECAY",
  "MEMEX_TENANT_FAIL_CLOSED",
  "MEMEX_PUBLIC_WRITE",
  "MEMEX_PUBLIC_READ_BODIES",
];

async function countSpendRows(): Promise<number> {
  const r = await storage
    .engine()
    .query<{ n: number }>("SELECT count(*)::int AS n FROM mcp_spend_log");
  return Number(r.rows[0]?.n ?? 0);
}

beforeAll(async () => {
  for (const k of NEUTRALISED) delete process.env[k];
  tmp = mkdtempSync(join(tmpdir(), "memex-continuity-bench-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  fixtures = loadContinuityCorpus();
  spendRowsBefore = await countSpendRows();
  daySpendBefore = await daySpendUsd(storage.engine(), "bench");
  // One Storage, one replay of the whole corpus; every test below reads it.
  run = await runContinuityCorpus(storage, fixtures);
  spendRowsAfter = await countSpendRows();
  daySpendAfter = await daySpendUsd(storage.engine(), "bench");
});

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

const probeById = (id: string): ContinuityProbeOutcome => {
  const p = run.probes.find((x) => x.id === id);
  if (!p) throw new Error(`no such continuity probe: ${id}`);
  return p;
};

// -- The loader is strict, or the labels mean nothing ----------------------

describe("continuity fixtures loader", () => {
  const minimal = {
    name: "x",
    description: "d",
    identities: [
      { id: "w", clientId: "c-w", writeSource: "t", readSources: ["t"], scopes: ["read", "write"] },
      { id: "r", clientId: "c-r", readSources: ["t"], scopes: ["read"] },
      { id: "o", clientId: "c-o", writeSource: "u", readSources: ["u"], scopes: ["read"] },
    ],
    writes: [
      {
        as: "w",
        op: "page_put",
        args: { slug: "decisions/d", type: "decision", title: "D", markdown_body: "b\n" },
      },
    ],
    probes: [
      { id: "recall", as: "r", op: "page_get", args: { slug: "decisions/d" }, gold: ["decisions/d"] },
      { id: "leak", as: "o", op: "page_get", args: { slug: "decisions/d" }, gold: [] },
    ],
  };
  const parse = (mutate: (f: Record<string, unknown>) => void): ContinuityFixture => {
    const f = structuredClone(minimal) as Record<string, unknown>;
    mutate(f);
    return parseContinuityFixture("t", f);
  };

  it("accepts a minimal well-formed fixture", () => {
    expect(parse(() => {}).probes.length).toBe(2);
  });

  it("rejects an unknown key rather than ignoring it", () => {
    expect(() => parse((f) => void (f["glod"] = []))).toThrow(ContinuityFixtureError);
  });

  it("rejects a missing gold label — [] must be deliberate, never absent", () => {
    expect(() =>
      parse((f) => {
        delete (f["probes"] as Record<string, unknown>[])[0]!["gold"];
      }),
    ).toThrow(/must be labelled/);
  });

  it("rejects an arg the shipped op does not declare", () => {
    // `body` is the fixture-file field; page_put's parameter is markdown_body,
    // and dispatch would write an empty page while the score looked plausible.
    expect(() =>
      parse((f) => {
        (f["writes"] as Record<string, unknown>[])[0]!["args"] = {
          slug: "decisions/d",
          type: "decision",
          body: "b",
        };
      }),
    ).toThrow(/is not a parameter of 'page_put'/);
  });

  it("refuses to let a fixture stamp its own writer", () => {
    expect(() =>
      parse((f) => {
        const args = (f["writes"] as Record<string, unknown>[])[0]!["args"] as Record<string, unknown>;
        args["written_by"] = "client:c-w";
      }),
    ).toThrow(/harness stamps the writing identity/);
  });

  it("rejects a fact recalled by a scoped reader that does not declare visibility", () => {
    expect(() =>
      parse((f) => {
        (f["writes"] as Record<string, unknown>[]).push({
          as: "w",
          op: "add_fact",
          args: { entity_slug: "decisions/d", fact: "a claim" },
        });
        (f["probes"] as Record<string, unknown>[])[0] = {
          id: "recall",
          as: "r",
          op: "entity_facts",
          args: { entity_slug: "decisions/d" },
          gold: ["fact:1"],
        };
      }),
    ).toThrow(/declare its visibility/);
  });

  it("rejects a corpus with no leak probe", () => {
    expect(() =>
      parse((f) => {
        (f["probes"] as Record<string, unknown>[]).pop();
      }),
    ).toThrow(/no probe is labelled/);
  });

  it("rejects a leak probe no paired call could ever have answered", () => {
    expect(() =>
      parse((f) => {
        const leak = (f["probes"] as Record<string, unknown>[])[1]!;
        (leak["args"] as Record<string, unknown>)["slug"] = "decisions/never-written";
        leak["op"] = "page_list";
        leak["args"] = { type: "decision" };
      }),
    ).toThrow(/could never have fired/);
  });

  it("rejects a recall probe run by the identity that wrote it", () => {
    expect(() =>
      parse((f) => {
        (f["probes"] as Record<string, unknown>[])[0]!["as"] = "w";
      }),
    ).toThrow(/measures a database, not continuity/);
  });

  it("rejects a gold slug that was seeded rather than written", () => {
    expect(() =>
      parse((f) => {
        f["pages"] = [{ slug: "decisions/seeded", type: "decision", title: "S", body: "b" }];
        (f["probes"] as Record<string, unknown>[])[0]!["gold"] = ["decisions/seeded"];
        (f["probes"] as Record<string, unknown>[])[0]!["args"] = { slug: "decisions/seeded" };
        (f["probes"] as Record<string, unknown>[])[1]!["args"] = { slug: "decisions/seeded" };
      }),
    ).toThrow(/provenance cannot be required/);
  });

  it("rejects a slug that is both prior brain state and a session-A write", () => {
    expect(() =>
      parse((f) => {
        f["pages"] = [{ slug: "decisions/d", type: "decision", title: "D", body: "b" }];
      }),
    ).toThrow(/measures the seeder/);
  });

  it("rejects requireProvenance on a leak probe, where it means nothing", () => {
    expect(() =>
      parse((f) => {
        (f["probes"] as Record<string, unknown>[])[1]!["requireProvenance"] = true;
      }),
    ).toThrow(/no gold to attach provenance to/);
  });

  it("rejects a query probe that would reach the unseamed refine embedder", () => {
    expect(() =>
      parse((f) => {
        (f["probes"] as Record<string, unknown>[])[1] = {
          id: "leak",
          as: "o",
          op: "query",
          args: { q: "d", refine: "narrow" },
          gold: [],
        };
      }),
    ).toThrow(/would call Bedrock/);
  });

  it("rejects a half-modelled public identity", () => {
    expect(() =>
      parse((f) => {
        (f["identities"] as Record<string, unknown>[])[2] = {
          id: "o",
          clientId: "public",
          isPublic: true,
          readSources: ["u"],
        };
      }),
    ).toThrow(/carries no grant of its own/);
  });
});

// -- The corpus itself -----------------------------------------------------

describe("continuity bench corpus", () => {
  it("ships the cases the family exists to cover", () => {
    expect(fixtures.map((f) => f.name)).toEqual([
      "decision-page-recall",
      "fact-ledger-recall",
      "scope-fence-negative",
    ]);
    expect(run.probes.length).toBe(21);
  });

  it("pins today's corpus scores", () => {
    const s = scorePush(run.scored);
    expect(s).toEqual({
      turns: 21,
      shouldSpeak: 12,
      shouldStaySilent: 9,
      precision: 1,
      recall: 0.9231,
      missRate: 0.0833,
      falseFireRate: 0,
    });
    // Kept as a readable line so a diff between two runs is one grep away.
    // `false_fire` is what the shared scorer calls it; the family reports it
    // as `leak` (scoreboard.ts) — same number, different incident.
    expect(formatScores("continuity", s)).toBe(
      "continuity: turns=21 speak=12 silent=9 precision=100.0% recall=92.3% " +
        "miss=8.3% false_fire=0.0%",
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
      // The lowercase probe is the only miss in the corpus: 4 of 5 gold handles.
      "decision-page-recall": [1, 0.8, 0.2, 0],
      "fact-ledger-recall": [1, 1, 0, 0],
      "scope-fence-negative": [1, 1, 0, 0],
    });
  });

  it("landed every session-A write", () => {
    // A write that failed turns every probe that depends on it into a miss, and
    // the pins would simply move to the lower number. Say so out loud instead.
    const failed = run.runs.flatMap((r) =>
      r.writes.filter((w) => w.error !== undefined).map((w) => `${r.fixture}#${w.index}: ${w.error}`),
    );
    expect(failed).toEqual([]);
    expect(run.runs.flatMap((r) => r.writes).length).toBe(8);
  });

  it("hands nothing to a reader that its label did not want", () => {
    const noise = run.probes.flatMap((p) => {
      const wanted = new Set([...p.gold, ...p.acceptable]);
      return p.injected.filter((h) => !wanted.has(h)).map((h) => `${p.id} -> ${h}`);
    });
    expect(noise).toEqual([]);
  });

  it("pins the known miss, so fixing it is visible as a broken pin", () => {
    const p = probeById("decision-page-recall#reader-volunteer-lowercase");
    expect(p.returned).toEqual([]);
    // The same question, capitalised, is answered — so the miss is the
    // extractor's, not the fence's or the fixture's.
    expect(probeById("decision-page-recall#reader-volunteer").injected).toEqual([
      "decisions/drop-the-nightly-reindex",
    ]);
  });
});

// -- Negative probes must have been capable of firing ----------------------
//
// The loader enforces the pairing statically; this asserts the paired call
// actually returned the item AT RUN TIME. Without it, an empty brain scores a
// perfect leak rate under every configuration, including a broken fence.

describe("leak probes are earned, not accidental", () => {
  it("every negative probe has a paired call that returned the item", () => {
    const stable = (a: Record<string, unknown>): string =>
      JSON.stringify(Object.fromEntries(Object.entries(a).sort(([x], [y]) => x.localeCompare(y))));
    const unproven: string[] = [];
    for (const fixture of fixtures) {
      const byId = new Map(fixture.probes.map((p) => [`${fixture.name}#${p.id}`, p] as const));
      for (const [id, probe] of byId) {
        if (probe.gold.length > 0) continue;
        const paired = fixture.probes.filter(
          (o) => o.gold.length > 0 && o.op === probe.op && stable(o.args) === stable(probe.args),
        );
        const answered = paired.some(
          (o) => probeById(`${fixture.name}#${o.id}`).injected.length > 0,
        );
        if (!answered) unproven.push(id);
      }
    }
    expect(unproven).toEqual([]);
  });

  it("counts the negative probes it claims to have run", () => {
    const silent = run.probes.filter((p) => p.gold.length === 0);
    expect(silent.map((p) => p.id)).toEqual([
      "decision-page-recall#outsider-page",
      "decision-page-recall#outsider-fact",
      "decision-page-recall#outsider-links",
      "decision-page-recall#outsider-volunteer",
      "fact-ledger-recall#outsider-mira",
      "fact-ledger-recall#outsider-cross-entity",
      "scope-fence-negative#public-resolve",
      "scope-fence-negative#public-volunteer",
      "scope-fence-negative#public-search",
    ]);
  });

  it("the public refusals are the ingress guard, not an empty brain", async () => {
    // Same two ops, same args, same corpus state — but called on dispatch
    // WITHOUT the guard the harness applies. Both hand the anonymous caller the
    // author's slug, which is precisely why the guard is what is being graded.
    const anon = { isPublic: true } as const;
    const resolved = await dispatchTool(
      storage,
      { name: "resolve_slugs", arguments: { query: "Legacy Importer" } },
      anon,
    );
    const volunteered = await dispatchTool(
      storage,
      {
        name: "volunteer_context",
        arguments: { window: "user: Is the Legacy Importer still running?" },
      },
      anon,
    );
    const text = (r: { content?: { text?: string }[] }): string => r.content?.[0]?.text ?? "";
    expect(text(resolved)).toContain("decisions/retire-the-legacy-importer");
    expect(text(volunteered)).toContain("decisions/retire-the-legacy-importer");
    expect(probeById("scope-fence-negative#public-resolve").refused).toBe(true);
    expect(probeById("scope-fence-negative#public-volunteer").refused).toBe(true);
    // The third public negative is a different mechanism: search IS reachable,
    // and the page-derived hits are dropped from the result instead.
    expect(probeById("scope-fence-negative#public-search").refused).toBe(false);
    expect(probeById("scope-fence-negative#public-search").returned).toEqual([]);
    expect(probeById("scope-fence-negative#member-search").returned).toEqual([
      "decisions/retire-the-legacy-importer",
    ]);
  });

  it("keeps the public identity from being degenerately blind", () => {
    // A public caller that could read nothing at all would score a perfect leak
    // rate for the wrong reason. It can still fetch a page it names.
    expect(probeById("scope-fence-negative#public-page").injected).toEqual([
      "decisions/retire-the-legacy-importer",
    ]);
  });
});

// -- Provenance is what stops a seeded page passing for a recall -----------

describe("provenance", () => {
  it("credits every gold handle to the session-A write", () => {
    const mismatches = run.probes.flatMap((p) =>
      p.provenanceMismatches.map((h) => `${p.id} -> ${h}`),
    );
    expect(mismatches).toEqual([]);
    const checked = run.runs
      .flatMap((r) => r.probes)
      .filter((p) => p.gold.length > 0 && p.injected.length > 0);
    expect(checked.length).toBe(11);
  });

  it("turns false when the row stops carrying the write's stamps", async () => {
    // The guard has to be able to FAIL, or "provenance verified" is decoration.
    // Tamper with the tenancy stamp on the fact the last fixture wrote, and the
    // same handle stops counting. It has to be the LAST fixture: every fixture
    // opens by emptying the brain, so an earlier fixture's row id now belongs
    // to whatever a later fixture wrote into the restarted sequence.
    const fixture = fixtures.find((f) => f.name === "scope-fence-negative")!;
    const write = run.runs
      .find((r) => r.fixture === "scope-fence-negative")!
      .writes.find((w) => w.op === "add_fact")!;
    expect(await carriesProvenance(storage, fixture, write)).toBe(true);
    await storage
      .engine()
      .query("UPDATE entity_facts SET source_id = 'team-a' WHERE id = $1", [write.factId]);
    expect(await carriesProvenance(storage, fixture, write)).toBe(false);
    await storage
      .engine()
      .query("UPDATE entity_facts SET source_id = $2 WHERE id = $1", [
        write.factId,
        write.writeSource,
      ]);
    expect(await carriesProvenance(storage, fixture, write)).toBe(true);
  });

  it("requires provenance of every recall probe in the shipped corpus", () => {
    const unchecked = fixtures.flatMap((f) =>
      f.probes.filter((p) => p.gold.length > 0 && !provenanceRequired(p)).map((p) => p.id),
    );
    expect(unchecked).toEqual([]);
  });
});

// -- Session B is a later session, not a warm cache ------------------------

describe("the session boundary", () => {
  it("answers the same after the cache is dropped", async () => {
    // A probe served out of a query cache written moments earlier is a cache
    // hit wearing continuity's clothes. The harness clears the cache between
    // the two sessions; this shows the ANSWER survives clearing it again — the
    // recall is a property of the database, not of what was ranked recently.
    // Compared as the handle set the score reads, not as raw JSON: rank scores
    // and the ranking's own explanation move with unrelated signals (a page_get
    // between the two calls bumps last_retrieved_at) and grading them here
    // would be pinning search's tuning under a continuity test's name.
    const identity = fixtures
      .find((f) => f.name === "scope-fence-negative")!
      .identities.find((i) => i.id === "member")!;
    const call = async (): Promise<string[]> => {
      const r = await dispatchTool(
        storage,
        { name: "search", arguments: { q: "Legacy Importer" } },
        dispatchOptionsFor(identity),
      );
      const body = JSON.parse(r.content?.[0]?.text ?? "{}") as { hits?: { sourcePath?: string }[] };
      return (body.hits ?? []).map((h) => String(h.sourcePath));
    };
    const warm = await call();
    await clearCache(storage.engine());
    const cold = await call();
    expect(cold).toEqual(warm);
    expect(cold).toContain("page://team-e/decisions/retire-the-legacy-importer");
  });

  it("empties the brain between fixtures", async () => {
    // The corpus ran on one Storage; the last fixture's rows are still there,
    // and every fixture starts by proving they are gone.
    const before = await storage
      .engine()
      .query<{ n: number }>("SELECT count(*)::int AS n FROM pages");
    expect(Number(before.rows[0]?.n)).toBeGreaterThan(0);
    await resetBrain(storage);
    await assertBrainEmpty(storage);
  });
});

// -- The scorer, on probes whose answers are known -------------------------
//
// A corpus pinned at leak=0% produces the same number under a working scorer
// and a broken one. These synthetic probes are the companion arithmetic test:
// they show the reduction and the scorer report a leak when there is one.

describe("scoring a probe set", () => {
  const outcome = (
    id: string,
    gold: string[],
    injected: string[],
  ): ContinuityProbeOutcome => ({
    id,
    fixture: "synthetic",
    as: "r",
    op: "page_get",
    gold,
    acceptable: [],
    returned: injected,
    provenanceMismatches: [],
    injected,
    refused: false,
  });

  it("reports a leak when a negative probe returns anything", () => {
    const scored: ScoredTurn[] = [
      outcome("a", ["x"], ["x"]),
      outcome("b", [], ["x"]),
      outcome("c", [], []),
    ].map(toScoredProbe);
    const s = scorePush(scored);
    expect(s.falseFireRate).toBe(0.5);
    expect(s.recall).toBe(1);
    // The leaked page was never wanted anywhere, so precision falls with it.
    expect(s.precision).toBe(0.5);
  });

  it("reports a miss when a recall probe returns nothing", () => {
    const s = scorePush([outcome("a", ["x"], []), outcome("b", ["y"], ["y"])].map(toScoredProbe));
    expect(s.recall).toBe(0.5);
    expect(s.missRate).toBe(0.5);
  });

  it("reports n/a, never 0%, for a probe set with no negative case", () => {
    const s = scorePush([outcome("a", ["x"], ["x"])].map(toScoredProbe));
    expect(s.falseFireRate).toBeNull();
  });

  it("drops a provenance mismatch from the score but keeps it visible", () => {
    const p = outcome("a", ["x"], []);
    p.returned = ["x"];
    p.provenanceMismatches = ["x"];
    const s = scorePush([toScoredProbe(p)]);
    expect(s.recall).toBe(0);
    expect(p.returned).toEqual(["x"]);
  });
});

// -- Free by default, and measured rather than claimed ---------------------

describe("cost", () => {
  it("attempts no paid model call at all", () => {
    // `trackedInvoke` books a row even when the call FAILS, so a zero delta
    // here is stronger than a zero dollar delta: nothing was even attempted.
    expect(spendRowsAfter).toBe(spendRowsBefore);
    expect(spendRowsAfter).toBe(0);
  });

  it("moves the day's spend by nothing", () => {
    expect(daySpendAfter).toBe(daySpendBefore);
    expect(daySpendAfter).toBe(0);
  });
});
