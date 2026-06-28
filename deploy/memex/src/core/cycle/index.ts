/**
 * Cycle — runs the maintenance phases (see ALL_PHASES) in order, returns a
 * per-phase envelope. Phases are independent: one failing doesn't stop others.
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
import {
  mirrorPagesPhase,
  type MirrorPagesResult,
} from "./mirror-pages.ts";
import { purgePhase, type PurgeResult } from "./purge.ts";
import { lintPhase, type LintPhaseResult } from "./lint.ts";
import {
  resolveSymbolEdgesPhase,
  type ResolveSymbolEdgesResult,
} from "./resolve-symbol-edges.ts";
import type { ExtractResult } from "../extract.ts";
import {
  extractAtomsPhase,
  type ExtractAtomsResult,
} from "../synthesis/atoms.ts";
import {
  synthesizeConceptsPhase,
  type SynthesizeConceptsResult,
} from "../synthesis/concepts.ts";
import {
  proposeTakesPhase,
  gradeTakesPhase,
  type ProposeTakesResult,
  type GradeTakesResult,
} from "../synthesis/takes.ts";
import {
  calibrationProfilePhase,
  type CalibrationProfileResult,
} from "../synthesis/calibration.ts";
import type { LlmFn } from "../llm/nova.ts";

export type PhaseName =
  | "lint"
  | "embed-stale"
  | "mirror-pages"
  | "embed-facts"
  | "extract"
  | "resolve-symbol-edges"
  | "reconcile-links"
  | "orphans-purge"
  | "frontmatter-inference"
  | "recompute-salience"
  | "extract-timeline"
  | "snapshot"
  | "purge"
  // Synthesis phases (Wave 5) — opt-in, LLM-backed, default-OFF (NOT in
  // ALL_PHASES). Run only when explicitly requested via options.phases.
  | "extract-atoms"
  | "synthesize-concepts"
  | "propose-takes"
  | "grade-takes"
  | "calibration-profile";

export const ALL_PHASES: readonly PhaseName[] = [
  "lint",
  "embed-stale",
  "mirror-pages",
  "embed-facts",
  "extract",
  "resolve-symbol-edges",
  "reconcile-links",
  "orphans-purge",
  "frontmatter-inference",
  "recompute-salience",
  "extract-timeline",
  "snapshot",
  "purge",
];

/**
 * Opt-in LLM-synthesis phases (Wave 5). Deliberately NOT in ALL_PHASES — they
 * spend Bedrock and only run when explicitly requested (`memex cycle --phases
 * extract-atoms,...`). Listed here so the CLI accepts them as valid phase names
 * while the default cycle stays free + deterministic.
 */
export const SYNTHESIS_PHASES: readonly PhaseName[] = [
  "extract-atoms",
  "synthesize-concepts",
  "propose-takes",
  "grade-takes",
  "calibration-profile",
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
    | MirrorPagesResult
    | PurgeResult
    | LintPhaseResult
    | ResolveSymbolEdgesResult
    | SnapshotResult
    | ExtractAtomsResult
    | SynthesizeConceptsResult
    | ProposeTakesResult
    | GradeTakesResult
    | CalibrationProfileResult;
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
  if (
    phase === "embed-stale" ||
    phase === "embed-facts" ||
    phase === "extract" ||
    phase === "mirror-pages" ||
    phase === "resolve-symbol-edges"
  ) {
    const errs = (
      detail as
        | EmbedStaleResult
        | EmbedFactsResult
        | ExtractResult
        | MirrorPagesResult
        | ResolveSymbolEdgesResult
        | undefined
    )?.errors;
    return Array.isArray(errs) && errs.length > 0 ? "warn" : "ok";
  }
  if (phase === "snapshot") {
    return (detail as SnapshotResult | undefined)?.persisted === false
      ? "warn"
      : "ok";
  }
  if (phase === "lint") {
    // A non-empty flagged count is content-conformance debt → warn (the phase
    // measures; frontmatter-inference fixes). Zero violations → ok.
    return ((detail as LintPhaseResult | undefined)?.flagged ?? 0) > 0
      ? "warn"
      : "ok";
  }
  if (phase === "orphans-purge") {
    const zero = (detail as OrphansPurgeResult | undefined)?.flagged
      ?.docs_with_zero_chunks;
    return Array.isArray(zero) && zero.length > 0 ? "warn" : "ok";
  }
  if (
    phase === "extract-atoms" ||
    phase === "synthesize-concepts" ||
    phase === "propose-takes" ||
    phase === "grade-takes" ||
    phase === "calibration-profile"
  ) {
    // Synthesis phases per-item fail-open: a non-empty errors[] means some
    // LLM calls failed but the run completed → warn (never fails the cycle).
    const errs = (detail as { errors?: unknown[] } | undefined)?.errors;
    return Array.isArray(errs) && errs.length > 0 ? "warn" : "ok";
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
  /**
   * Synthesis knobs (Wave 5 LLM phases). All optional; `llmFn` is the test
   * seam (omitted in prod → the real Bedrock Nova client). Caps bound LLM
   * spend per run.
   */
  synthesis?: {
    llmFn?: LlmFn;
    modelId?: string;
    maxDocs?: number;
    maxConcepts?: number;
    maxTakes?: number;
    minGraded?: number;
  };
  /** Optional progress sink. */
  progress?: ProgressSink;
}

// Per-phase wall-clock deadline. A phase that hangs (e.g. a Bedrock/Nova call
// with no client timeout) otherwise wedges the WHOLE tick: `await fn()` never
// returns, the phase loop never advances, runCycleOnce never resolves, and the
// cycle loop's `finally` never releases the db-lock — so the maintenance cycle
// stalls until the lock TTL lapses and stays stuck every subsequent tick.
// Default 15 min (generous for a large embed-stale backlog under its per-cycle
// cap); `MEMEX_CYCLE_PHASE_TIMEOUT_MS=0` disables. A timed-out phase is recorded
// as `fail` and the cycle proceeds to its remaining phases (incl. snapshot) and
// releases the lock — liveness over the leaked in-flight work.
function phaseTimeoutMs(): number {
  const raw = process.env.MEMEX_CYCLE_PHASE_TIMEOUT_MS;
  if (raw === undefined || raw === "") return 15 * 60 * 1000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 15 * 60 * 1000;
}

export function withPhaseTimeout<T>(
  phase: PhaseName,
  fn: () => Promise<T>,
  ms: number = phaseTimeoutMs(),
): Promise<T> {
  if (ms <= 0) return fn();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`phase ${phase} timed out after ${ms}ms`)),
      ms,
    );
    (timer as unknown as { unref?: () => void }).unref?.();
    fn().then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
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
    const detail = (await withPhaseTimeout(phase, fn)) as PhaseResult["detail"];
    const status = deriveStatus(phase, detail);
    // Per-phase memory telemetry: a live OOM (a bun cycle process hit 3.48 GB
    // RSS → kernel kill mid-tick) needs the spiking phase named. Cheap; on by
    // default, silence with MEMEX_CYCLE_RSS_LOG=0.
    if (process.env.MEMEX_CYCLE_RSS_LOG !== "0") {
      const rssMb = Math.round(process.memoryUsage().rss / (1024 * 1024));
      console.error(`[cycle] phase ${phase} done status=${status} rss=${rssMb}MB dur=${Date.now() - start}ms`);
    }
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
      case "lint":
        r = await runPhase(engine, p, () => lintPhase(engine), progress);
        break;
      case "embed-stale": {
        const o: EmbedStaleOptions = {};
        if (options.staleDays !== undefined) o.staleDays = options.staleDays;
        if (options.embedMaxPerCycle !== undefined)
          o.maxPerCycle = options.embedMaxPerCycle;
        r = await runPhase(engine, p, () => embedStalePhase(engine, o), progress);
        break;
      }
      case "mirror-pages": {
        const storage = options.storage;
        r = await runPhase(
          engine,
          p,
          () =>
            storage
              ? mirrorPagesPhase(storage)
              : Promise.resolve<MirrorPagesResult>({
                  scanned: 0,
                  mirrored: 0,
                  removed: 0,
                  errors: [],
                }),
          progress,
        );
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
      case "resolve-symbol-edges":
        r = await runPhase(engine, p, () => resolveSymbolEdgesPhase(engine), progress);
        break;
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
      case "purge":
        r = await runPhase(engine, p, () => purgePhase(engine), progress);
        break;
      // Synthesis phases (Wave 5) — LLM-backed, opt-in. Order matters:
      // atoms -> concepts -> takes -> grade -> calibration.
      case "extract-atoms":
        r = await runPhase(
          engine,
          p,
          () => extractAtomsPhase(engine, options.synthesis ?? {}),
          progress,
        );
        break;
      case "synthesize-concepts":
        r = await runPhase(
          engine,
          p,
          () => synthesizeConceptsPhase(engine, options.synthesis ?? {}),
          progress,
        );
        break;
      case "propose-takes":
        r = await runPhase(
          engine,
          p,
          () => proposeTakesPhase(engine, options.synthesis ?? {}),
          progress,
        );
        break;
      case "grade-takes":
        r = await runPhase(
          engine,
          p,
          () => gradeTakesPhase(engine, options.synthesis ?? {}),
          progress,
        );
        break;
      case "calibration-profile":
        r = await runPhase(
          engine,
          p,
          () => calibrationProfilePhase(engine, options.synthesis ?? {}),
          progress,
        );
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
