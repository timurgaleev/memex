/**
 * Eval upgrades — config-vs-config A/B, run-all per-mode aggregate, and the
 * regression gate. Hermetic: the searchFn seam returns canned rankings, so
 * no Bedrock and no corpus needed (the storage handle is just plumbing).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runEval,
  parseEvalConfig,
  evalRun,
  loadQrels,
  type EvalOptions,
} from "../src/commands/eval.ts";
import { Storage } from "../src/core/storage.ts";
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
    expect(records[0]!.metrics!.ndcg).toBe(1);
    // One expected path per query, k = 5.
    expect(records[0]!.metrics!.precision).toBeCloseTo(0.2, 9);
    expect(records[0]!.metrics!.mrr_ci95).toEqual({ lo: 1, hi: 1 });
    expect(records[0]!.qrels_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(records[0]!.run_config_hash).toMatch(/^[0-9a-f]{64}$/);
    // Different mode bundles are different run configs.
    expect(records[0]!.run_config_hash).not.toBe(records[1]!.run_config_hash);

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

    // The table renders the new columns, and a legacy line without them.
    const legacy: EvalResultRecord = {
      run_id: "run-legacy",
      ran_at: "2099-01-01T00:00:00Z",
      suite: "qrels",
      mode: "conservative",
      status: "completed",
      duration_ms: 1,
      metrics: { mean_recall: 0.5, mean_mrr: 0.5, hit_rate: 0.5 },
    };
    writeFileSync(out, readFileSync(out, "utf-8") + JSON.stringify(legacy) + "\n");
    const cap3 = capture();
    try {
      code = await runEvalCompareCmd({ input: out });
    } finally {
      cap3.restore();
    }
    expect(code).toBe(0);
    const table = cap3.lines.join("\n");
    expect(table).toContain("ndcg");
    expect(table).toMatch(/balanced\s+1\.000\s+1\.000\s+1\.000\s+0\.200\s+100\.0\s+\[1\.000–1\.000\]/);
    expect(table).toMatch(/conservative\s+0\.500\s+0\.500\s+—\s+—\s+50\.0\s+—\s+run-legacy/);
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

describe("run fingerprint", () => {
  it("is stable across identical runs and moves with rrfK or the qrels bytes", async () => {
    const storage = new Storage({ dbPath: join(tmp, "fp.pglite") });
    const qrels = loadQrels(qrelsPath);
    const search = cannedSearch(true);
    const a = await evalRun(storage, qrels, { name: "a", rrfK: 60 }, { searchFn: search });
    const b = await evalRun(storage, qrels, { name: "renamed", rrfK: 60 }, { searchFn: search });
    const c = await evalRun(storage, qrels, { name: "a", rrfK: 1 }, { searchFn: search });
    expect(a.run_config_hash).toBe(b.run_config_hash);
    expect(a.run_config_hash).not.toBe(c.run_config_hash);

    const otherQrels = join(tmp, "qrels-other.json");
    writeFileSync(otherQrels, readFileSync(qrelsPath, "utf-8") + "\n");
    const d = await evalRun(storage, loadQrels(otherQrels), { name: "a", rrfK: 60 }, { searchFn: search });
    expect(d.qrels_sha256).not.toBe(a.qrels_sha256);
    expect(d.run_config_hash).not.toBe(a.run_config_hash);
  });

  it("reports nDCG, P@k and the bootstrap intervals in eval output with a glossary", async () => {
    const cap = capture();
    try {
      await runEval({ qrelsPath, configPath: cfgPath, searchFn: cannedSearch(false) });
    } finally {
      cap.restore();
    }
    const out = JSON.parse(cap.lines.join("\n"));
    // q1 hits at rank 1, q2 misses entirely.
    expect(out.meanNdcg).toBeCloseTo(0.5, 9);
    expect(out.meanPrecision).toBeCloseTo(0.1, 9);
    expect(out.mrrCi95.lo).toBeLessThanOrEqual(out.meanReciprocalRank);
    expect(out.mrrCi95.hi).toBeGreaterThanOrEqual(out.meanReciprocalRank);
    expect(out.perQuery[0].ndcg).toBe(1);
    expect(typeof out.glossary.meanNdcg).toBe("string");
    process.exitCode = 0;
  });
});

describe("gate intervals", () => {
  async function gate(baselinePath: string, good: boolean, write = false) {
    const cap = capture();
    let code: number;
    try {
      code = await runEvalGate({
        baseline: baselinePath,
        ...(write ? { writeBaseline: true } : {}),
        qrelsPath,
        configPath: cfgPath,
        searchFn: cannedSearch(good),
      });
    } finally {
      cap.restore();
    }
    return { code, out: JSON.parse(cap.lines.join("\n")) };
  }

  it("stores per-query scores and reports a paired delta interval next to an unchanged verdict", async () => {
    const baselinePath = join(tmp, "baseline-ci.json");
    expect((await gate(baselinePath, true, true)).code).toBe(0);
    const saved = JSON.parse(readFileSync(baselinePath, "utf-8"));
    expect(saved.per_query).toEqual({ q1: { recall: 1, rr: 1 }, q2: { recall: 1, rr: 1 } });
    expect(saved.qrels_sha256).toMatch(/^[0-9a-f]{64}$/);

    const { code, out } = await gate(baselinePath, false);
    expect(code).toBe(1);
    expect(out.delta_ci95.n).toBe(2);
    expect(out.delta_ci95.mean_mrr.lo).toBeLessThan(0);
    expect(out.qrels_changed).toBeUndefined();
    expect(out.glossary.delta_ci95).toBeString();
  });

  it("gates a legacy baseline as before and flags a changed qrels checksum", async () => {
    const legacyPath = join(tmp, "baseline-legacy.json");
    writeFileSync(
      legacyPath,
      JSON.stringify({ saved_at: "", k: 5, mean_recall: 1, mean_mrr: 1, hit_rate: 1 }),
    );
    const legacy = await gate(legacyPath, false);
    expect(legacy.code).toBe(1);
    expect(legacy.out.delta_ci95).toBeUndefined();
    expect(legacy.out.qrels_changed).toBeUndefined();

    const mismatchPath = join(tmp, "baseline-mismatch.json");
    writeFileSync(
      mismatchPath,
      JSON.stringify({
        saved_at: "",
        k: 5,
        mean_recall: 1,
        mean_mrr: 1,
        hit_rate: 1,
        qrels_sha256: "0".repeat(64),
      }),
    );
    const mismatch = await gate(mismatchPath, true);
    expect(mismatch.code).toBe(0);
    expect(mismatch.out.qrels_changed).toBe(true);
  });
});
