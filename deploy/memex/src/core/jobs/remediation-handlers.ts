/**
 * Durable-queue handler for `remediation` jobs.
 *
 * The doctor self-heal layer (`core/remediation.ts`) enqueues one durable job
 * per safe deterministic fix. This module registers the single `remediation`
 * handler that dispatches on `payload.action`:
 *
 *   - "reembed-source" → re-embed a source stuck at 0% coverage.
 *   - "cycle-phase"    → re-run a wedged maintenance-cycle phase.
 *
 * memex has NO server-side subagent runtime, so each action is a plain durable
 * job the ordinary worker executes. The concrete runners are injected
 * (`RemediationDeps`) so this module stays decoupled from the heavy cycle /
 * embed code and is trivially testable. When no deps are injected the defaults
 * lazily import the real runners and are best-effort (a runner that isn't
 * available throws, and the job fails + retries via the normal queue policy).
 *
 * To activate in the live worker, call `registerRemediationHandlers()` once at
 * worker startup (alongside `new Worker(...)`).
 */
import type { JobHandler } from "./types.ts";
import { registerHandler } from "./handlers.ts";
import { REMEDIATION_JOB_KIND } from "../remediation.ts";

/** Injectable runners so the handler never hard-couples to cycle/embed code. */
export interface RemediationDeps {
  /** Re-embed a source that is stuck at 0% coverage. */
  reembedSource?: (sourceId: string) => Promise<Record<string, unknown> | void>;
  /** Re-run one maintenance-cycle phase. */
  runCyclePhase?: (phase: string) => Promise<Record<string, unknown> | void>;
}

/**
 * Build the `remediation` job handler. Exported for tests, which inject fake
 * deps and assert the correct runner fires for each `payload.action`.
 */
export function makeRemediationHandler(deps: RemediationDeps = {}): JobHandler {
  return async (payload) => {
    const action = typeof payload["action"] === "string" ? payload["action"] : "";
    switch (action) {
      case "reembed-source": {
        const sourceId = payload["source_id"];
        if (typeof sourceId !== "string" || sourceId.length === 0) {
          throw new Error("remediation reembed-source: missing source_id");
        }
        const run = deps.reembedSource ?? defaultReembedSource;
        const out = await run(sourceId);
        return { action, source_id: sourceId, ...(out ?? {}) };
      }
      case "cycle-phase": {
        const phase = typeof payload["phase"] === "string" ? payload["phase"] : "";
        if (phase.length === 0) {
          throw new Error("remediation cycle-phase: missing phase");
        }
        const run = deps.runCyclePhase ?? defaultRunCyclePhase;
        const out = await run(phase);
        return { action, phase, ...(out ?? {}) };
      }
      default:
        throw new Error(`remediation: unknown action '${action}'`);
    }
  };
}

/**
 * Register the `remediation` handler on the process-local registry. Idempotent
 * per process. Call once at worker startup.
 */
export function registerRemediationHandlers(deps: RemediationDeps = {}): void {
  registerHandler(REMEDIATION_JOB_KIND, makeRemediationHandler(deps));
}

/**
 * Default re-embed runner. Lazily imports the reindex path so a fix job can
 * re-embed a single source without this module pulling the embed stack into
 * every process. Best-effort: throws (→ job retry) if the runner is absent.
 */
async function defaultReembedSource(
  sourceId: string,
): Promise<Record<string, unknown> | void> {
  const mod = (await import("../../commands/reindex.ts")) as Record<string, unknown>;
  const fn = mod["runReindex"];
  if (typeof fn !== "function") {
    throw new TypeError(
      "remediation reembed-source: no reindex runner available (inject deps.reembedSource)",
    );
  }
  await (fn as (o: { source: string }) => Promise<void>)({ source: sourceId });
}

/**
 * Default cycle-phase runner. Lazily imports the cycle command and runs the
 * single named phase. Best-effort: throws (→ job retry) if unavailable.
 */
async function defaultRunCyclePhase(
  phase: string,
): Promise<Record<string, unknown> | void> {
  const mod = (await import("../../commands/cycle.ts")) as Record<string, unknown>;
  const fn = mod["runCycle"];
  if (typeof fn !== "function") {
    throw new TypeError(
      "remediation cycle-phase: no cycle runner available (inject deps.runCyclePhase)",
    );
  }
  return (await (fn as (o: { phases: string[] }) => Promise<Record<string, unknown> | void>)(
    { phases: [phase] },
  )) as Record<string, unknown> | void;
}
