/**
 * Cycle — runs the 6 maintenance phases in order, returns a per-phase
 * envelope. Phases are independent: one failing doesn't stop the others.
 */
import type { Engine } from "../engine/interface.ts";
import type { Storage } from "../storage.ts";
import { type ProgressSink, NOOP_PROGRESS } from "../output/progress.ts";
import {
  embedStalePhase,
  type EmbedStaleOptions,
  type EmbedStaleResult,
} from "./embed-stale.ts";
import { extractPhase, type ExtractPhaseOptions } from "./extract.ts";
import { embedFactsPhase, type EmbedFactsResult } from "./embed-facts.ts";
import {
  reconcileLinksPhase,
  type ReconcileLinksResult,
} from "./reconcile-links.ts";
import {
  orphansPurgePhase,
  type OrphansPurgeResult,
} from "./orphans-purge.ts";
import {
  frontmatterInferencePhase,
  type FrontmatterInferenceResult,
} from "./frontmatter-inference.ts";
import {
  recomputeSaliencePhase,
  type RecomputeSalienceResult,
} from "./recompute-salience.ts";
import {
  extractMeetingTimelinePhase,
  type MeetingTimelineResult,
} from "../timeline-meetings.ts";
import { snapshotPhase, type SnapshotResult } from "./snapshot.ts";
import type { ExtractResult } from "../extract.ts";

export type PhaseName =
  | "embed-stale"
  | "embed-facts"
  | "extract"
  | "reconcile-links"
  | "orphans-purge"
  | "frontmatter-inference"
  | "recompute-salience"
  | "extract-timeline"
  | "snapshot";

export const ALL_PHASES: readonly PhaseName[] = [
  "embed-stale",
  "embed-facts",
  "extract",
  "reconcile-links",
  "orphans-purge",
  "frontmatter-inference",
  "recompute-salience",
  "extract-timeline",
  "snapshot",
];

/**
 * Three-state phase outcome (faithful to the reference's ok/warn/fail
 * envelope). `warn` = the phase COMPLETED (didn't throw) but reported
 * non-fatal issues — e.g. embed-stale re-embedded most chunks but a few hit
 * a transient Bedrock error, or snapshot computed but couldn't persist. A
 * warn does NOT fail the cycle; it surfaces a partial success that the old
 * binary `ok` silently swallowed.
 */
export type PhaseStatus = "ok" | "warn" | "fail";

export interface PhaseResult {
  phase: PhaseName;
  /** Back-compat: true unless the phase threw. A `warn` is still `ok:true`. */
  ok: boolean;
  /** Three-state outcome — prefer this over `ok` for new consumers. */
  status: PhaseStatus;
  durationMs: number;
  detail?:
    | EmbedStaleResult
    | EmbedFactsResult
    | ExtractResult
    | ReconcileLinksResult
    | OrphansPurgeResult
    | FrontmatterInferenceResult
    | RecomputeSalienceResult
    | MeetingTimelineResult
    | SnapshotResult;
  error?: string;
}

export interface CycleResult {
  startedAt: string;
  finishedAt: string;
  phases: PhaseResult[];
  /** Back-compat: true unless a phase FAILED (warns don't flip it). */
  ok: boolean;
  /** Worst phase outcome: fail if any failed, else warn if any warned, else ok. */
  status: PhaseStatus;
}

/**
 * Derive a SUCCEEDED phase's status from its detail. Explicit per-phase
 * rules (not duck-typing) so the warn signal is precise:
 *   - embed-stale / extract: any per-document error → warn (the phase still
 *     succeeds on the rest; those failures are transient/recoverable next
 *     cycle). Both carry the identical `{ errors: [...] }` shape.
 *   - snapshot: computed but not persisted → warn (soft failure).
 *   - orphans-purge: a `docs_with_zero_chunks` entry is a CORRUPT index row
 *     (a document with no chunks) → warn. `docs_missing_on_disk` is left as
 *     `ok`: a file deleted/renamed between syncs is routine churn the purge
 *     handles, not an anomaly (would be noisy as a warn).
 * reconcile-links `unresolved` is BY DESIGN informational (a wikilink to a
 * not-yet-created page is normal), so it stays `ok`.
 */
export function deriveStatus(
  phase: PhaseName,
  detail: PhaseResult["detail"],
): PhaseStatus {
  if (phase === "embed-stale" || phase === "embed-facts" || phase === "extract") {
    const errs = (
      detail as EmbedStaleResult | EmbedFactsResult | ExtractResult | undefined
    )?.errors;
    return Array.isArray(errs) && errs.length > 0 ? "warn" : "ok";
  }
  if (phase === "snapshot") {
    return (detail as SnapshotResult | undefined)?.persisted === false
      ? "warn"
      : "ok";
  }
  if (phase === "orphans-purge") {
    const zero = (detail as OrphansPurgeResult | undefined)?.flagged
      ?.docs_with_zero_chunks;
    return Array.isArray(zero) && zero.length > 0 ? "warn" : "ok";
  }
  // reconcile-links, frontmatter-inference, recompute-salience,
  // extract-timeline: no failure-bearing detail — they either complete or throw
  // (a single failed write aborts the whole phase → caught as fail above), so a
  // SUCCEEDED run is always ok. A NEW phase falls here too: add an explicit rule
  // above if it can partially fail, rather than letting it default to ok
  // unnoticed.
  return "ok";
}

export interface CycleOptions {
  /** Limit which phases to run. Default = all. */
  phases?: PhaseName[];
  /**
   * Storage handle for phases that need Storage-level helpers (the slug
   * resolver + timeline writer). The recipe always passes it; when absent
   * (e.g. an engine-only test harness) the `extract-timeline` phase no-ops.
   */
  storage?: Storage;
  /** Forwarded to embed-stale. */
  staleDays?: number;
  /** Forwarded to embed-stale. */
  embedMaxPerCycle?: number;
  /** Forwarded to extract. */
  extractMaxDocs?: number;
  /** Optional progress sink. */
  progress?: ProgressSink;
}

async function runPhase<T>(
  engine: Engine,
  phase: PhaseName,
  fn: () => Promise<T>,
  progress: ProgressSink,
): Promise<PhaseResult> {
  const start = Date.now();
  progress({ kind: "phase", op: "cycle", phase, ts: start });
  try {
    const detail = (await fn()) as PhaseResult["detail"];
    const status = deriveStatus(phase, detail);
    if (status === "warn") {
      progress({
        kind: "log",
        op: "cycle",
        level: "warn",
        message: `phase ${phase} completed with warnings`,
        ts: Date.now(),
      });
    }
    return {
      phase,
      ok: true,
      status,
      durationMs: Date.now() - start,
      detail,
    };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    progress({
      kind: "log",
      op: "cycle",
      level: "error",
      message: `phase ${phase} failed: ${error}`,
      ts: Date.now(),
    });
    return {
      phase,
      ok: false,
      status: "fail",
      durationMs: Date.now() - start,
      error,
    };
  }
}

export async function runCycleOnce(
  engine: Engine,
  options: CycleOptions = {},
): Promise<CycleResult> {
  const progress = options.progress ?? NOOP_PROGRESS;
  const requested = options.phases ?? ALL_PHASES;
  const startedAt = new Date().toISOString();
  progress({ kind: "started", op: "cycle", ts: Date.now() });

  const phases: PhaseResult[] = [];
  for (const p of requested) {
    let r: PhaseResult;
    switch (p) {
      case "embed-stale": {
        const o: EmbedStaleOptions = {};
        if (options.staleDays !== undefined) o.staleDays = options.staleDays;
        if (options.embedMaxPerCycle !== undefined)
          o.maxPerCycle = options.embedMaxPerCycle;
        r = await runPhase(engine, p, () => embedStalePhase(engine, o), progress);
        break;
      }
      case "embed-facts":
        r = await runPhase(engine, p, () => embedFactsPhase(engine), progress);
        break;
      case "extract": {
        const o: ExtractPhaseOptions = {};
        if (options.extractMaxDocs !== undefined) o.maxDocs = options.extractMaxDocs;
        r = await runPhase(engine, p, () => extractPhase(engine, o), progress);
        break;
      }
      case "reconcile-links":
        r = await runPhase(engine, p, () => reconcileLinksPhase(engine), progress);
        break;
      case "orphans-purge":
        r = await runPhase(engine, p, () => orphansPurgePhase(engine), progress);
        break;
      case "frontmatter-inference":
        r = await runPhase(
          engine,
          p,
          () => frontmatterInferencePhase(engine),
          progress,
        );
        break;
      case "recompute-salience":
        r = await runPhase(
          engine,
          p,
          () => recomputeSaliencePhase(engine),
          progress,
        );
        break;
      case "extract-timeline": {
        const storage = options.storage;
        r = await runPhase(
          engine,
          p,
          () =>
            storage
              ? extractMeetingTimelinePhase(storage)
              : Promise.resolve<MeetingTimelineResult>({
                  meetings_scanned: 0,
                  entries_written: 0,
                  attendees_touched: 0,
                }),
          progress,
        );
        break;
      }
      case "snapshot":
        r = await runPhase(engine, p, () => snapshotPhase(engine), progress);
        break;
      default:
        r = {
          phase: p,
          ok: false,
          status: "fail",
          durationMs: 0,
          error: `unknown phase: ${p as string}`,
        };
    }
    phases.push(r);
  }

  const finishedAt = new Date().toISOString();
  const ok = phases.every((p) => p.ok);
  const status: PhaseStatus = phases.some((p) => p.status === "fail")
    ? "fail"
    : phases.some((p) => p.status === "warn")
      ? "warn"
      : "ok";
  progress({
    kind: ok ? "completed" : "failed",
    op: "cycle",
    result: { phases: phases.length, ok },
    error: ok ? undefined : "one or more phases failed",
    ts: Date.now(),
  } as never);
  return { startedAt, finishedAt, phases, ok, status };
}
