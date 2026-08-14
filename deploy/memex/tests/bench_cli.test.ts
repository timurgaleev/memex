/**
 * `memex bench` — the command wrapper around the three families.
 *
 * MEASURES: that the CLI surface behaves the way an operator and a CI job need
 * it to, independent of what the numbers say. Four claims, each of which has a
 * cheap way to be quietly false:
 *
 *   1. It exits 0 on a completed run, even a bad one. The bench REPORTS; the
 *      ratchet lives in the per-family test files. A command that exits 1 on a
 *      low score becomes a second gate that drifts from the first.
 *   2. `--json` is a machine surface, so it is parsed here rather than
 *      eyeballed — a scoreboard that prints valid-looking text and emits
 *      malformed JSON fails only for the consumer.
 *   3. The run costs nothing, and that is MEASURED against the spend ledger
 *      rather than asserted in a comment. The instrument is itself checked
 *      against a planted row, because "the ledger did not move" is exactly what
 *      a ledger nobody wired up also reports.
 *   4. `--live` is refused by name, before anything opens a database or bills.
 *
 * The flag map is guarded elsewhere: `tests/cli_args.test.ts` derives each
 * command's flag set from the `case` body in `cli.ts`, so a `bench` case that
 * reads a flag the map does not declare (or vice versa) fails there, not here.
 *
 * What a green run here does NOT tell you: that any family's numbers are right.
 * That is `tests/push_bench.test.ts`, `tests/bench_continuity.test.ts` and
 * `tests/bench_fidelity.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { setSpendLedgerEngine } from "../src/core/budget.ts";
import { parseArgs } from "../src/cli-args.ts";
import {
  runBenchCli,
  runBenchOnStorage,
  spendLedgerSnapshot,
  isBenchFamilySelector,
  BENCH_FAMILIES,
  FAMILY_CORPUS_SUBDIR,
  LIVE_REFUSAL,
} from "../src/commands/bench.ts";
import type { BenchReport } from "../src/core/bench/scoreboard.ts";

let tmp: string;
let storage: Storage;

/** The whole bench, run once — every assertion below reads this one run. */
let report: BenchReport;
let spendDelta: { calls: number; usd: number };

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-bench-cli-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();

  const before = await spendLedgerSnapshot(storage.engine());
  report = await runBenchOnStorage(storage);
  const after = await spendLedgerSnapshot(storage.engine());
  spendDelta = { calls: after.calls - before.calls, usd: after.usd - before.usd };
});

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
  // `Storage.init` repoints the module-global spend ledger (storage.ts:74), and
  // this file opened two databases that are now gone. Leaving a CLOSED engine
  // wired would make a later file's paid call log a warning from a dead handle;
  // null is the module's own documented "not wired yet" state.
  setSpendLedgerEngine(null);
});

/** Collect what the command wrote to stdout while it ran. */
async function captureStdout(fn: () => Promise<number>): Promise<{ code: number; out: string }> {
  const original = process.stdout.write.bind(process.stdout);
  let out = "";
  process.stdout.write = ((chunk: unknown) => {
    out += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    return { code: await fn(), out };
  } finally {
    process.stdout.write = original;
  }
}

/** Same, for the refusal path. */
async function captureStderr(fn: () => Promise<number>): Promise<{ code: number; err: string }> {
  const original = process.stderr.write.bind(process.stderr);
  let err = "";
  process.stderr.write = ((chunk: unknown) => {
    err += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    return { code: await fn(), err };
  } finally {
    process.stderr.write = original;
  }
}

// -- Cost ------------------------------------------------------------------

describe("the default run is free, and the zero is measured", () => {
  it("books no model spend at all", () => {
    expect(spendDelta.usd).toBe(0);
    expect(report.spendUsd).toBe(0);
  });

  it("books no model CALL either, priced or not", () => {
    // The stronger half. An unpriced model books a $0 row (budget.ts:522-529),
    // so a run that really reached Bedrock and a run that never left the
    // process both report "$0.0000" by amount. Only the row count separates
    // them, and the row count is the one that would move if a stub seam were
    // dropped from a harness.
    expect(spendDelta.calls).toBe(0);
  });

  it("would notice if spend happened — the instrument reads a real ledger", async () => {
    // Without this, every assertion above is also satisfied by a snapshot
    // function that returns a constant, or by a ledger no `Storage.init` ever
    // wired up. Plant one row and watch both numbers move.
    const before = await spendLedgerSnapshot(storage.engine());
    await storage.engine().query(
      `INSERT INTO mcp_spend_log (operation, spend_cents, provider, model)
       VALUES ('bench-self-test', 42, 'bedrock', 'test-model')`,
    );
    const after = await spendLedgerSnapshot(storage.engine());
    expect(after.calls - before.calls).toBe(1);
    expect(after.usd - before.usd).toBeCloseTo(0.42, 10);
    await storage.engine().query(`DELETE FROM mcp_spend_log WHERE operation = 'bench-self-test'`);
  });

  it("clears the paid env knobs the stubs do not cover", () => {
    // Fact dedup embeds every candidate with a real Titan call unless
    // `dedup.embed` is injected, and the worth gate calls a judge. Neither is
    // covered by the sonnetFn stub, so "free" would depend on the operator's
    // shell — the run clears them in its own process instead.
    for (const k of ["MEMEX_FACTS_DEDUP", "MEMEX_FACTS_DEDUP_LLM", "MEMEX_WORTH_GATE"]) {
      expect(`${k}=${process.env[k]}`).toBe(`${k}=undefined`);
    }
  });
});

// -- The report ------------------------------------------------------------

describe("the scoreboard covers every family", () => {
  it("runs all three by default, in scoreboard order", () => {
    expect(report.families.map((f) => f.family)).toEqual([...BENCH_FAMILIES]);
  });

  it("says which corpus and which mode produced the numbers", () => {
    expect(report.corpus).toBe("shipped");
    expect(report.mode).toBe("stub");
  });

  it("reports a real denominator for every family", () => {
    // A family that silently loaded an empty corpus would still render a line;
    // it would just render one made of `n/a`. The denominators are what say the
    // exam was actually sat.
    for (const f of report.families) {
      if (f.family === "fidelity") {
        expect(f.goldTotal).toBeGreaterThan(0);
        expect(f.rejectTotal).toBeGreaterThan(0);
      } else {
        expect(f.scores.turns).toBeGreaterThan(0);
        expect(f.scores.shouldSpeak).toBeGreaterThan(0);
        // The paired anti-gaming term needs cases of its own or it cannot fail.
        expect(f.scores.shouldStaySilent).toBeGreaterThan(0);
      }
    }
  });
});

// -- The command wrapper ---------------------------------------------------

describe("memex bench", () => {
  it("prints the block and exits 0", async () => {
    const { code, out } = await captureStdout(() => runBenchCli({ family: "push" }));
    expect(code).toBe(0);
    expect(out).toMatch(/^bench \(corpus: shipped, mode: stub, spend: \$0\.0000\)\n/);
    expect(out).toMatch(/\npush {8}turns=\d+ speak=\d+ silent=\d+ P=/);
  });

  it("emits parseable JSON under --json, not a formatted block", async () => {
    const { code, out } = await captureStdout(() =>
      runBenchCli({ family: "push", json: true }),
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(parsed["mode"]).toBe("stub");
    expect(parsed["spendUsd"]).toBe(0);
    expect(parsed["push"]).toBeDefined();
    // Only the selected family appears — a key present with null numbers would
    // read as "measured, and zero".
    expect(parsed["continuity"]).toBeUndefined();
    expect(parsed["fidelity"]).toBeUndefined();
  });

  it("exits 0 on a corpus it scores badly — it reports, it does not gate", async () => {
    // The claim that matters for CI: the ratchet is in the test files, not in
    // the exit code. This corpus is labelled so the brain cannot possibly hit
    // it — recall 0, miss 100% — and the command still exits 0.
    const root = join(tmp, "bad-corpus");
    mkdirSync(join(root, FAMILY_CORPUS_SUBDIR.push), { recursive: true });
    writeFileSync(
      join(root, FAMILY_CORPUS_SUBDIR.push, "unreachable.json"),
      JSON.stringify({
        name: "unreachable",
        description: "A gold label nothing in the turn text could ever resolve to.",
        pages: [
          {
            slug: "notes/unfindable",
            type: "note",
            title: "Unfindable",
            body: "A page whose title appears nowhere in the conversation.\n",
          },
        ],
        turns: [{ role: "user", text: "and then we went home", gold: ["notes/unfindable"] }],
      }),
    );

    const { code, out } = await captureStdout(() =>
      runBenchCli({ family: "push", corpus: root, json: true }),
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(out) as { corpus: string; push: { recall: number | null } };
    expect(parsed.corpus).toBe(root);
    expect(parsed.push.recall).toBe(0);
  });

  it("names the missing directory instead of running a partial corpus", async () => {
    const missing = join(tmp, "no-such-root");
    await expect(runBenchCli({ corpus: missing })).rejects.toThrow(
      new RegExp(`no push corpus at ${missing.replace(/[/\\]/g, "\\$&")}`),
    );
  });
});

// -- --live ----------------------------------------------------------------

describe("--live", () => {
  it("is refused by name, not silently downgraded to the stub arm", async () => {
    const { code, err } = await captureStderr(() => runBenchCli({ live: true, family: "push" }));
    expect(code).not.toBe(0);
    expect(err).toContain(LIVE_REFUSAL);
    expect(err).toMatch(/costs real money/);
  });

  it("refuses before it does any work", async () => {
    // A refusal that arrives after the run has already billed is not a refusal.
    // Nothing runs, so nothing is printed on stdout at all.
    const { out } = await captureStdout(async () => {
      const original = process.stderr.write.bind(process.stderr);
      process.stderr.write = (() => true) as typeof process.stderr.write;
      try {
        return await runBenchCli({ live: true });
      } finally {
        process.stderr.write = original;
      }
    });
    expect(out).toBe("");
  });
});

// -- Flag wiring -----------------------------------------------------------

describe("flag wiring", () => {
  it("accepts exactly the flags bench reads", () => {
    expect(() =>
      parseArgs(["bench", "--family", "all", "--corpus", "/tmp/x", "--json", "--live"]),
    ).not.toThrow();
    expect(() => parseArgs(["bench", "--limit", "5"])).toThrow(/unknown flag '--limit'/);
  });

  it("treats --json and --live as booleans, so neither eats a positional", () => {
    const r = parseArgs(["bench", "--json", "--family", "push"]);
    expect(r.flags.has("--json")).toBe(true);
    expect(r.values.get("--family")).toBe("push");
    expect(r.positional).toEqual([]);
  });

  it("knows the family selectors and refuses a typo", () => {
    for (const f of [...BENCH_FAMILIES, "all"]) expect(isBenchFamilySelector(f)).toBe(true);
    for (const f of ["puhs", "", "push,continuity", "PUSH"]) {
      expect(isBenchFamilySelector(f)).toBe(false);
    }
  });
});
