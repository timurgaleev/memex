/**
 * `memex eval` — retrieval quality harness.
 *
 * Reads tests/eval/qrels.json (curated ground-truth: query → expected
 * source_paths), runs each query through hybridSearch, computes
 * Recall@k and Mean Reciprocal Rank, prints a report.
 *
 * No mocking — runs against the live brain so the metric reflects
 * production behaviour. That makes this command Bedrock-billable;
 * keep `qrels.json` small.
 *
 * Exit code: 0 if average recall@5 >= MIN_RECALL (default 0.6), else 1.
 * Suitable as a CI gate or a periodic dream-loop sanity check.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Storage } from "../core/storage.ts";
import { loadConfig } from "../core/config.ts";
import { hybridSearch } from "../core/search/index.ts";
import { wilsonCI, smallSampleNote, type WilsonCI } from "../core/wilson.ts";

interface Qrel {
  id: string;
  query: string;
  expected_paths: string[];
  notes?: string;
}
interface Qrels {
  queries: Qrel[];
}

interface QueryReport {
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

interface EvalReport {
  ok: boolean;
  k: number;
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

export interface EvalOptions {
  /** Override path to the qrels file. Defaults to tests/eval/qrels.json. */
  qrelsPath?: string;
  /** k for Recall@k. Default 5. */
  k?: number;
  /** Min average recall@k below which we exit non-zero. Default 0.6. */
  minRecall?: number;
}

function defaultQrelsPath(): string {
  // Resolve relative to the source file location — the harness ships in
  // the same package as the qrels and the tests dir is alongside src/.
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "../../tests/eval/qrels.json");
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

export async function runEval(opts: EvalOptions = {}): Promise<void> {
  const qrelsPath = opts.qrelsPath ?? defaultQrelsPath();
  const k = opts.k ?? 5;
  const minRecall = opts.minRecall ?? 0.6;

  if (!existsSync(qrelsPath)) {
    throw new Error(`memex eval: qrels file not found at ${qrelsPath}`);
  }
  const qrels = JSON.parse(readFileSync(qrelsPath, "utf8")) as Qrels;
  if (!qrels.queries || qrels.queries.length === 0) {
    throw new Error(`memex eval: no queries in ${qrelsPath}`);
  }

  const config = loadConfig();
  const storage = new Storage(config);
  await storage.init();

  const perQuery: QueryReport[] = [];
  const errors: { id: string; error: string }[] = [];
  try {
    for (const q of qrels.queries) {
      // Per-query isolation: one query throwing (a bad embed, a transient DB
      // error) must not abort the whole run and lose every other measurement.
      try {
        const hits = await hybridSearch(storage, q.query, { k });
        const paths = hits.map((h) => h.sourcePath);
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
    await storage.close();
  }

  const meanRecall =
    perQuery.reduce((s, q) => s + q.recallAtK, 0) / perQuery.length;
  const meanReciprocalRank =
    perQuery.reduce((s, q) => s + q.mrr, 0) / perQuery.length;
  // Hit-rate: fraction of queries that retrieved at least one expected path.
  // A binomial proportion — bound it with a Wilson 95% CI so the score reads
  // as a measurement with uncertainty, not a bare number.
  const hitCount = perQuery.filter((q) => q.recallAtK > 0).length;
  const hitRate = hitCount / perQuery.length;
  const wilsonCi95 = wilsonCI(hitCount, perQuery.length);
  const note = smallSampleNote(perQuery.length);
  const ok = meanRecall >= minRecall;

  const report: EvalReport = {
    ok,
    k,
    meanRecall,
    meanReciprocalRank,
    hitRate,
    wilsonCi95,
    ...(note ? { smallSampleNote: note } : {}),
    errors,
    perQuery,
  };
  console.log(JSON.stringify(report, null, 2));
  if (!ok) process.exitCode = 1;
}
