/**
 * `memex eval` — retrieval quality harness.
 *
 * Reads tests/eval/qrels.json (curated ground-truth: query → expected
 * source_paths), runs each query through hybridSearch, computes
 * Recall@k and Mean Reciprocal Rank, prints a report.
 *
 * Config-vs-config instrumentation:
 *   memex eval [--rrf-k N] [--expand|--no-expand] [--rerank] [--max-pool]
 *              [--graph-signals] [--cosine-rescore] [--relational-arm]
 *              [--dedup-type-ratio X] [--qrels PATH] [--k N]
 *   memex eval --config-a '<json|path>' --config-b '<json|path>'
 *              A/B: run both knob sets over the same qrels, print the delta.
 *
 * Eval queries always bypass the query cache — the metric must measure
 * retrieval, not cache reuse.
 *
 * No mocking — runs against the live brain so the metric reflects
 * production behaviour. That makes this command Bedrock-billable;
 * keep `qrels.json` small.
 *
 * Exit code (single-run mode): 0 if average recall@5 >= MIN_RECALL
 * (default 0.6), else 1. Suitable as a CI gate.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Storage } from "../core/storage.ts";
import { withStorage } from "./with-storage.ts";
import { loadConfig } from "../core/config.ts";
import { hybridSearch } from "../core/search/index.ts";
import { wilsonCI, smallSampleNote, type WilsonCI } from "../core/wilson.ts";

export interface Qrel {
  id: string;
  query: string;
  expected_paths: string[];
  notes?: string;
}
export interface Qrels {
  queries: Qrel[];
}

export interface QueryReport {
  id: string;
  query: string;
  recallAtK: number;
  mrr: number;
  hits: number;
  expected: number;
  topPaths: string[];
  /** Set when this query threw — the run continues, the query scores 0. */
  error?: string;
}

export interface EvalReport {
  ok: boolean;
  k: number;
  configName: string;
  meanRecall: number;
  meanReciprocalRank: number;
  /** Fraction of queries that retrieved at least one expected path (a binomial
   *  proportion the Wilson CI bounds). */
  hitRate: number;
  wilsonCi95: WilsonCI;
  /** Present when n < 30 — the CI is too wide to act on. */
  smallSampleNote?: string;
  /** Queries that threw (isolated, did not abort the run). */
  errors: { id: string; error: string }[];
  perQuery: QueryReport[];
}

/**
 * One ranking-knob set for an eval run. Maps 1:1 onto hybridSearch per-call
 * options; `dedupTypeRatio` is env-plane (MEMEX_MAX_TYPE_RATIO) and is
 * wrapped around the run.
 */
export interface EvalKnobConfig {
  name?: string;
  k?: number;
  rrfK?: number;
  expansion?: boolean;
  rerank?: boolean;
  maxPool?: boolean;
  graphSignals?: boolean;
  cosineRescore?: boolean;
  relationalArm?: boolean;
  backlinkBoost?: boolean;
  tokenBudget?: number;
  dedupTypeRatio?: number;
}

/** Parse a knob config from inline JSON or a file path. */
export function parseEvalConfig(pathOrJson: string): EvalKnobConfig {
  const trimmed = pathOrJson.trimStart();
  const raw =
    trimmed.startsWith("{") || trimmed.startsWith("[")
      ? pathOrJson
      : readFileSync(pathOrJson, "utf-8");
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("eval config must be a JSON object");
  }
  return parsed as EvalKnobConfig;
}

export interface EvalOptions {
  /** Override path to the qrels file. Defaults to tests/eval/qrels.json. */
  qrelsPath?: string;
  /** k for Recall@k. Default 5. */
  k?: number;
  /** Min average recall@k below which we exit non-zero. Default 0.6. */
  minRecall?: number;
  /** Knob set for the (single or A-side) run. */
  config?: EvalKnobConfig;
  /** B-side knob set — presence turns on A/B comparison mode. */
  configB?: EvalKnobConfig;
  /** Test seam — replaces the live hybridSearch call; returns ranked paths. */
  searchFn?: (
    storage: Storage,
    query: string,
    cfg: EvalKnobConfig,
    k: number,
  ) => Promise<string[]>;
  configPath?: string;
}

export function defaultQrelsPath(): string {
  // Resolve relative to the source file location — the harness ships in
  // the same package as the qrels and the tests dir is alongside src/.
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "../../tests/eval/qrels.json");
}

export function loadQrels(qrelsPath: string): Qrels {
  if (!existsSync(qrelsPath)) {
    throw new Error(`memex eval: qrels file not found at ${qrelsPath}`);
  }
  const qrels = JSON.parse(readFileSync(qrelsPath, "utf8")) as Qrels;
  if (!qrels.queries || qrels.queries.length === 0) {
    throw new Error(`memex eval: no queries in ${qrelsPath}`);
  }
  return qrels;
}

function recallAtK(found: string[], expected: string[]): number {
  if (expected.length === 0) {
    // "Should return nothing relevant" queries — recall is meaningless.
    // We treat any non-relevant top-k as full recall (1.0) to keep the
    // metric well-behaved; the eval still flags drift through MRR=0.
    return 1.0;
  }
  const set = new Set(expected);
  const hit = found.filter((p) => set.has(p)).length;
  return hit / expected.length;
}

function reciprocalRank(found: string[], expected: string[]): number {
  if (expected.length === 0) return 0;
  const set = new Set(expected);
  for (let i = 0; i < found.length; i++) {
    if (set.has(found[i] ?? "")) {
      return 1 / (i + 1);
    }
  }
  return 0;
}

async function defaultSearchFn(
  storage: Storage,
  query: string,
  cfg: EvalKnobConfig,
  k: number,
): Promise<string[]> {
  const hits = await hybridSearch(storage, query, {
    k,
    noCache: true,
    ...(cfg.rrfK !== undefined ? { rrfK: cfg.rrfK } : {}),
    ...(cfg.expansion !== undefined ? { expansion: cfg.expansion } : {}),
    ...(cfg.rerank !== undefined ? { rerank: cfg.rerank } : {}),
    ...(cfg.maxPool !== undefined ? { maxPool: cfg.maxPool } : {}),
    ...(cfg.graphSignals !== undefined ? { graphSignals: cfg.graphSignals } : {}),
    ...(cfg.cosineRescore !== undefined ? { cosineRescore: cfg.cosineRescore } : {}),
    ...(cfg.relationalArm !== undefined ? { relationalArm: cfg.relationalArm } : {}),
    ...(cfg.backlinkBoost !== undefined ? { backlinkBoost: cfg.backlinkBoost } : {}),
    ...(cfg.tokenBudget !== undefined ? { tokenBudget: cfg.tokenBudget } : {}),
  });
  return hits.map((h) => h.sourcePath);
}

/**
 * Run one knob config over the qrels set. Per-query isolation: one query
 * throwing must not abort the run. `dedupTypeRatio` is applied by wrapping
 * MEMEX_MAX_TYPE_RATIO for the duration (the knob is env-resolved per call).
 */
export async function evalRun(
  storage: Storage,
  qrels: Qrels,
  cfg: EvalKnobConfig,
  opts: { k?: number; searchFn?: EvalOptions["searchFn"] } = {},
): Promise<EvalReport> {
  const k = opts.k ?? cfg.k ?? 5;
  const searchFn = opts.searchFn ?? defaultSearchFn;

  const prevRatio = process.env["MEMEX_MAX_TYPE_RATIO"];
  if (cfg.dedupTypeRatio !== undefined) {
    process.env["MEMEX_MAX_TYPE_RATIO"] = String(cfg.dedupTypeRatio);
  }
  const perQuery: QueryReport[] = [];
  const errors: { id: string; error: string }[] = [];
  try {
    for (const q of qrels.queries) {
      try {
        const paths = await searchFn(storage, q.query, cfg, k);
        perQuery.push({
          id: q.id,
          query: q.query,
          recallAtK: recallAtK(paths, q.expected_paths),
          mrr: reciprocalRank(paths, q.expected_paths),
          hits: paths.length,
          expected: q.expected_paths.length,
          topPaths: paths.slice(0, 3),
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push({ id: q.id, error: msg });
        perQuery.push({
          id: q.id,
          query: q.query,
          recallAtK: 0,
          mrr: 0,
          hits: 0,
          expected: q.expected_paths.length,
          topPaths: [],
          error: msg,
        });
      }
    }
  } finally {
    if (cfg.dedupTypeRatio !== undefined) {
      if (prevRatio === undefined) delete process.env["MEMEX_MAX_TYPE_RATIO"];
      else process.env["MEMEX_MAX_TYPE_RATIO"] = prevRatio;
    }
  }

  const meanRecall = perQuery.reduce((s, q) => s + q.recallAtK, 0) / perQuery.length;
  const meanReciprocalRank = perQuery.reduce((s, q) => s + q.mrr, 0) / perQuery.length;
  // Hit-rate: fraction of queries that retrieved at least one expected path.
  // A binomial proportion — bound it with a Wilson 95% CI so the score reads
  // as a measurement with uncertainty, not a bare number.
  const hitCount = perQuery.filter((q) => q.recallAtK > 0).length;
  const hitRate = hitCount / perQuery.length;
  const wilsonCi95 = wilsonCI(hitCount, perQuery.length);
  const note = smallSampleNote(perQuery.length);

  return {
    ok: true,
    k,
    configName: cfg.name ?? "default",
    meanRecall,
    meanReciprocalRank,
    hitRate,
    wilsonCi95,
    ...(note ? { smallSampleNote: note } : {}),
    errors,
    perQuery,
  };
}

export async function runEval(opts: EvalOptions = {}): Promise<void> {
  const qrels = loadQrels(opts.qrelsPath ?? defaultQrelsPath());
  const k = opts.k ?? 5;
  const minRecall = opts.minRecall ?? 0.6;
  const cfgA: EvalKnobConfig = { name: "Config A", ...(opts.config ?? {}) };

  const storage = new Storage(loadConfig(opts.configPath));
  return withStorage(storage, async () => {
    if (opts.configB) {
      const cfgB: EvalKnobConfig = { name: "Config B", ...opts.configB };
      const evalOpts = { k, ...(opts.searchFn ? { searchFn: opts.searchFn } : {}) };
      const a = await evalRun(storage, qrels, cfgA, evalOpts);
      const b = await evalRun(storage, qrels, cfgB, evalOpts);
      const delta = {
        meanRecall: b.meanRecall - a.meanRecall,
        meanReciprocalRank: b.meanReciprocalRank - a.meanReciprocalRank,
        hitRate: b.hitRate - a.hitRate,
      };
      console.log(JSON.stringify({ ok: true, mode: "ab", k, a, b, delta }, null, 2));
      return;
    }

    const report = await evalRun(storage, qrels, cfgA, {
      k,
      ...(opts.searchFn ? { searchFn: opts.searchFn } : {}),
    });
    const ok = report.meanRecall >= minRecall;
    console.log(JSON.stringify({ ...report, ok }, null, 2));
    if (!ok) process.exitCode = 1;
  });
}
