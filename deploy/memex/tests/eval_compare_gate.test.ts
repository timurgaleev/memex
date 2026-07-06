/**
 * Eval upgrades — config-vs-config A/B, run-all per-mode aggregate, and the
 * regression gate. Hermetic: the searchFn seam returns canned rankings, so
 * no Bedrock and no corpus needed (the storage handle is just plumbing).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEval, parseEvalConfig, type EvalOptions } from "../src/commands/eval.ts";
import {
  runEvalRunAll,
  runEvalCompareCmd,
  runEvalGate,
  configForMode,
  groupLatest,
  gateVerdict,
  type EvalResultRecord,
} from "../src/commands/eval-compare.ts";

const tmp = mkdtempSync(join(tmpdir(), "memex-eval-cmp-"));
const cfgDir = join(tmp, ".memex");
const cfgPath = join(cfgDir, "config.json");
const qrelsPath = join(tmp, "qrels.json");

function capture(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  return { lines, restore: () => (console.log = orig) };
}

beforeAll(() => {
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(
    cfgPath,
    JSON.stringify({
      database: { type: "pglite", path: join(cfgDir, "brain.pglite") },
      embedding: {
        provider: "bedrock-titan",
        model: "amazon.titan-embed-text-v2:0",
        region: "eu-west-1",
      },
      storage: {},
    }),
  );
  writeFileSync(
    qrelsPath,
    JSON.stringify({
      queries: [
        { id: "q1", query: "alpha", expected_paths: ["notes/a.md"] },
        { id: "q2", query: "beta", expected_paths: ["notes/b.md"] },
      ],
    }),
  );
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// Canned ranker: "good" configs put the expected doc first; "bad" ones miss q2.
type SearchFn = NonNullable<EvalOptions["searchFn"]>;
function cannedSearch(good: boolean): SearchFn {
  return async (_s, query) => {
    if (query === "alpha") return ["notes/a.md", "notes/x.md"];
    return good ? ["notes/b.md"] : ["notes/x.md", "notes/y.md"];
  };
}
// Config-sensitive ranker for the A/B test: the config's name decides quality.
const abSearch: SearchFn = async (_s, query, cfg) =>
  cannedSearch(cfg.name === "good")(_s, query, cfg, 5);

describe("parseEvalConfig", () => {
  it("accepts inline JSON and file paths, rejects non-objects", () => {
    expect(parseEvalConfig('{"rrfK": 30}')).toEqual({ rrfK: 30 });
    const p = join(tmp, "cfg.json");
    writeFileSync(p, JSON.stringify({ name: "file", rerank: true }));
    expect(parseEvalConfig(p)).toEqual({ name: "file", rerank: true });
    expect(() => parseEvalConfig("[1,2]")).toThrow(/JSON object/);
  });
});

describe("A/B compare", () => {
  it("runs both configs over the same qrels and reports the delta", async () => {
    const cap = capture();
    try {
      await runEval({
        qrelsPath,
        configPath: cfgPath,
        config: { name: "good" },
        configB: { name: "bad" },
        searchFn: abSearch,
      });
    } finally {
      cap.restore();
    }
    const out = JSON.parse(cap.lines.join("\n"));
    expect(out.mode).toBe("ab");
    expect(out.a.meanRecall).toBe(1);
    expect(out.b.meanRecall).toBe(0.5);
    expect(out.delta.meanRecall).toBeCloseTo(-0.5);
  });
});

describe("run-all + compare", () => {
  it("appends one JSONL record per mode and compare renders the latest", async () => {
    const out = join(tmp, "eval-results.jsonl");
    const cap = capture();
    let code: number;
    try {
      code = await runEvalRunAll({
        modes: ["conservative", "balanced"],
        qrelsPath,
        out,
        configPath: cfgPath,
        searchFn: cannedSearch(true),
      });
    } finally {
      cap.restore();
    }
    expect(code).toBe(0);
    const lines = readFileSync(out, "utf-8").trim().split("\n");
    expect(lines.length).toBe(2);
    const records = lines.map((l) => JSON.parse(l) as EvalResultRecord);
    expect(records.map((r) => r.mode)).toEqual(["conservative", "balanced"]);
    expect(records[0]!.metrics!.mean_recall).toBe(1);

    const cap2 = capture();
    try {
      code = await runEvalCompareCmd({ input: out, json: true });
    } finally {
      cap2.restore();
    }
    expect(code).toBe(0);
    const grouped = JSON.parse(cap2.lines.join("\n")).grouped;
    expect(grouped.qrels.conservative.metrics.mean_recall).toBe(1);
    expect(grouped.qrels.balanced.metrics.mean_recall).toBe(1);
  });

  it("configForMode mirrors the mode bundle knobs", () => {
    const c = configForMode("balanced");
    expect(c.rerank).toBe(true);
    expect(c.expansion).toBe(false);
    expect(c.tokenBudget).toBe(12000);
    expect(configForMode("conservative").tokenBudget).toBeUndefined();
  });

  it("groupLatest keeps the newest record per (suite, mode)", () => {
    const mk = (ran_at: string, run_id: string): EvalResultRecord => ({
      run_id,
      ran_at,
      suite: "qrels",
      mode: "balanced",
      status: "completed",
      duration_ms: 1,
    });
    const g = groupLatest([mk("2026-01-01T00:00:00Z", "old"), mk("2026-02-01T00:00:00Z", "new")]);
    expect(g["qrels"]!["balanced"]!.run_id).toBe("new");
  });
});

describe("gate", () => {
  it("gateVerdict: baseline drop beyond max fails; floor applies without baseline", () => {
    const base = { saved_at: "", k: 5, mean_recall: 0.9, mean_mrr: 0.8, hit_rate: 1 };
    expect(
      gateVerdict({ meanRecall: 0.88, meanReciprocalRank: 0.79 }, base, 0.05, 0.6).pass,
    ).toBe(true);
    expect(
      gateVerdict({ meanRecall: 0.7, meanReciprocalRank: 0.79 }, base, 0.05, 0.6).pass,
    ).toBe(false);
    expect(gateVerdict({ meanRecall: 0.5, meanReciprocalRank: 0 }, null, 0.05, 0.6).pass).toBe(
      false,
    );
    expect(gateVerdict({ meanRecall: 0.7, meanReciprocalRank: 0 }, null, 0.05, 0.6).pass).toBe(
      true,
    );
  });

  it("writes a baseline on pass, then fails a regressed run against it", async () => {
    const baselinePath = join(tmp, "baseline.json");
    const cap = capture();
    let code: number;
    try {
      code = await runEvalGate({
        baseline: baselinePath,
        writeBaseline: true,
        qrelsPath,
        configPath: cfgPath,
        searchFn: cannedSearch(true),
      });
    } finally {
      cap.restore();
    }
    expect(code).toBe(0);
    expect(existsSync(baselinePath)).toBe(true);

    const cap2 = capture();
    try {
      code = await runEvalGate({
        baseline: baselinePath,
        qrelsPath,
        configPath: cfgPath,
        searchFn: cannedSearch(false),
      });
    } finally {
      cap2.restore();
    }
    expect(code).toBe(1);
    const out = JSON.parse(cap2.lines.join("\n"));
    expect(out.ok).toBe(false);
    expect(out.reasons.length).toBeGreaterThan(0);
  });
});
