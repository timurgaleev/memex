/**
 * The one reporting surface for `memex bench`.
 *
 * Three families, one block, one line each — so the diff between two runs is a
 * diff between two blocks and not an exercise in reading three different
 * report shapes.
 *
 * WHY THE FAMILIES SHARE A SCORER BUT NOT A LINE. Push and continuity are the
 * same arithmetic: `scorePush` is generic over `ScoredTurn`, and continuity's
 * "leak rate" is literally `falseFireRate` over probes labelled to return
 * nothing. So both carry a `PushScores` here and the family only chooses what
 * to CALL each number — `falseFireRate` is `falsefire` for push and `leak` for
 * continuity, because a page volunteered on a silent turn and a page shown to
 * the wrong tenant are the same miscount and very different incidents. Fidelity
 * cannot be expressed as a set score at all (its `distortionRate` grades fields
 * on rows that already matched), so it carries its own numbers.
 *
 * `formatScores` (`push-metrics.ts:126`) is deliberately NOT reused for the
 * push line. Its four-term line is pinned character-for-character at
 * `tests/push_bench.test.ts:167-170` and is a fine standalone report, but it
 * has no room for a family-specific tail term and no column alignment, and
 * bending it to serve three callers would break the pin it exists to hold. Two
 * formatters, each pinned where it is read.
 *
 * A rate with no denominator prints `n/a`, never `0.0%` — that is the whole
 * point of `PushScores` returning `null` there. "0% leak" for a corpus with no
 * negative probes reads as a pass for an exam nobody sat.
 */

import type { PushScores } from "./push-metrics.ts";

/** Push: the shipped corpus, scored exactly as `tests/push_bench.test.ts` pins it. */
export interface PushFamilyReport {
  family: "push";
  scores: PushScores;
}

/**
 * Continuity: `scorePush` over the probe set. `recall` is continuity recall,
 * `missRate` is continuity miss, `falseFireRate` is the leak rate.
 */
export interface ContinuityFamilyReport {
  family: "continuity";
  scores: PushScores;
}

/** Write-back fidelity: graded on ledger rows, never on the run's counters. */
export interface FidelityFamilyReport {
  family: "fidelity";
  /** |gold| — claims the pipeline was required to preserve. */
  goldTotal: number;
  /** |L| — ledger rows the run actually wrote. */
  ledgerRows: number;
  /** |reject| — claims the pipeline was required to discard. */
  rejectTotal: number;
  fidelityPrecision: number | null;
  fidelityRecall: number | null;
  dropCompliance: number | null;
  /** Of the gold facts that landed, the fraction that landed altered. */
  distortionRate: number | null;
}

export type BenchFamilyReport =
  | PushFamilyReport
  | ContinuityFamilyReport
  | FidelityFamilyReport;

export interface BenchReport {
  /** `"shipped"`, or the `--corpus` directory the run was pointed at. */
  corpus: string;
  /**
   * Always `"stub"` in v1. The field exists because the numbers below are
   * stub-model numbers and a scoreboard that does not say so invites being
   * read as live behaviour; it is a literal type rather than a union because a
   * mode with no producer is a claim, not a feature.
   */
  mode: "stub";
  /**
   * Observed model spend for the run, in USD. Snapshotted from the budget
   * ledger before and after, not assumed — a "free by default" claim with no
   * measurement behind it is the kind of statement this bench exists to stop.
   */
  spendUsd: number;
  /** In the order they should print. The CLI decides which families ran. */
  families: BenchFamilyReport[];
}

function pct(n: number | null): string {
  return n === null ? "n/a" : `${(n * 100).toFixed(1)}%`;
}

/** Widest family name plus a gutter, so the numbers line up under each other. */
const LABEL_WIDTH = 12;

function formatFamily(r: BenchFamilyReport): string {
  const label = r.family.padEnd(LABEL_WIDTH);
  switch (r.family) {
    case "push": {
      const s = r.scores;
      return (
        `${label}turns=${s.turns} speak=${s.shouldSpeak} silent=${s.shouldStaySilent} ` +
        `P=${pct(s.precision)} R=${pct(s.recall)} ` +
        `miss=${pct(s.missRate)} falsefire=${pct(s.falseFireRate)}`
      );
    }
    case "continuity": {
      const s = r.scores;
      return (
        `${label}probes=${s.turns} speak=${s.shouldSpeak} silent=${s.shouldStaySilent} ` +
        `P=${pct(s.precision)} R=${pct(s.recall)} ` +
        `miss=${pct(s.missRate)} leak=${pct(s.falseFireRate)}`
      );
    }
    case "fidelity":
      return (
        `${label}gold=${r.goldTotal} written=${r.ledgerRows} ` +
        `P=${pct(r.fidelityPrecision)} R=${pct(r.fidelityRecall)} ` +
        `drop=${pct(r.dropCompliance)} distortion=${pct(r.distortionRate)}`
      );
  }
}

/** The human-readable block. One header line, then one line per family. */
export function formatScoreboard(report: BenchReport): string {
  const header =
    `bench (corpus: ${report.corpus}, mode: ${report.mode}, ` +
    `spend: $${report.spendUsd.toFixed(4)})`;
  return [header, ...report.families.map(formatFamily)].join("\n");
}

/** The `--json` shape: the same numbers, under the names each family reports. */
export interface ScoreboardJson {
  corpus: string;
  mode: "stub";
  spendUsd: number;
  push?: {
    turns: number;
    shouldSpeak: number;
    shouldStaySilent: number;
    precision: number | null;
    recall: number | null;
    missRate: number | null;
    falseFireRate: number | null;
  };
  continuity?: {
    probes: number;
    shouldRecall: number;
    shouldStaySilent: number;
    precision: number | null;
    continuityRecall: number | null;
    continuityMiss: number | null;
    leakRate: number | null;
  };
  fidelity?: {
    goldTotal: number;
    ledgerRows: number;
    rejectTotal: number;
    fidelityPrecision: number | null;
    fidelityRecall: number | null;
    dropCompliance: number | null;
    distortionRate: number | null;
  };
}

/**
 * Machine-readable form. Keys are the family's own vocabulary, not the
 * scorer's: a consumer diffing two runs should see `leakRate` move, not have
 * to know that continuity borrows `falseFireRate` to compute it.
 */
export function scoreboardJson(report: BenchReport): ScoreboardJson {
  const out: ScoreboardJson = {
    corpus: report.corpus,
    mode: report.mode,
    spendUsd: report.spendUsd,
  };
  for (const r of report.families) {
    if (r.family === "push") {
      out.push = {
        turns: r.scores.turns,
        shouldSpeak: r.scores.shouldSpeak,
        shouldStaySilent: r.scores.shouldStaySilent,
        precision: r.scores.precision,
        recall: r.scores.recall,
        missRate: r.scores.missRate,
        falseFireRate: r.scores.falseFireRate,
      };
    } else if (r.family === "continuity") {
      out.continuity = {
        probes: r.scores.turns,
        shouldRecall: r.scores.shouldSpeak,
        shouldStaySilent: r.scores.shouldStaySilent,
        precision: r.scores.precision,
        continuityRecall: r.scores.recall,
        continuityMiss: r.scores.missRate,
        leakRate: r.scores.falseFireRate,
      };
    } else {
      out.fidelity = {
        goldTotal: r.goldTotal,
        ledgerRows: r.ledgerRows,
        rejectTotal: r.rejectTotal,
        fidelityPrecision: r.fidelityPrecision,
        fidelityRecall: r.fidelityRecall,
        dropCompliance: r.dropCompliance,
        distortionRate: r.distortionRate,
      };
    }
  }
  return out;
}
