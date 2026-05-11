/**
 * Cycle — runs the 6 maintenance phases in order, returns a per-phase
 * envelope. Phases are independent: one failing doesn't stop the others.
 */
import type { Engine } from "../engine/interface.ts";
import { type ProgressSink, NOOP_PROGRESS } from "../output/progress.ts";
import {
  embedStalePhase,
  type EmbedStaleOptions,
  type EmbedStaleResult,
} from "./embed-stale.ts";
import { extractPhase, type ExtractPhaseOptions } from "./extract.ts";
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
import { snapshotPhase, type SnapshotResult } from "./snapshot.ts";
import type { ExtractResult } from "../extract.ts";

export type PhaseName =
  | "embed-stale"
  | "extract"
  | "reconcile-links"
  | "orphans-purge"
  | "frontmatter-inference"
  | "snapshot";

export const ALL_PHASES: readonly PhaseName[] = [
  "embed-stale",
  "extract",
  "reconcile-links",
  "orphans-purge",
  "frontmatter-inference",
  "snapshot",
];

export interface PhaseResult {
  phase: PhaseName;
  ok: boolean;
  durationMs: number;
  detail?:
    | EmbedStaleResult
    | ExtractResult
    | ReconcileLinksResult
    | OrphansPurgeResult
    | FrontmatterInferenceResult
    | SnapshotResult;
  error?: string;
}

export interface CycleResult {
  startedAt: string;
  finishedAt: string;
  phases: PhaseResult[];
  ok: boolean;
}

export interface CycleOptions {
  /** Limit which phases to run. Default = all. */
  phases?: PhaseName[];
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
    return {
      phase,
      ok: true,
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
      case "snapshot":
        r = await runPhase(engine, p, () => snapshotPhase(engine), progress);
        break;
      default:
        r = {
          phase: p,
          ok: false,
          durationMs: 0,
          error: `unknown phase: ${p as string}`,
        };
    }
    phases.push(r);
  }

  const finishedAt = new Date().toISOString();
  const ok = phases.every((p) => p.ok);
  progress({
    kind: ok ? "completed" : "failed",
    op: "cycle",
    result: { phases: phases.length, ok },
    error: ok ? undefined : "one or more phases failed",
    ts: Date.now(),
  } as never);
  return { startedAt, finishedAt, phases, ok };
}
