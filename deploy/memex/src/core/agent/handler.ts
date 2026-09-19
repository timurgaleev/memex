/**
 * The `subagent` job handler: validates the payload, caps the spend and runs
 * the agent loop for one job.
 *
 * Registered by serve only when MEMEX_AGENT_ENABLED=1. The kind is not a
 * built-in, so with the flag off a submit is refused outright rather than
 * queued for a worker that will never run it.
 */
import type { Storage } from "../storage.ts";
import type { JobHandler } from "../jobs/types.ts";
import { registerHandler } from "../jobs/handlers.ts";
import { SUBAGENT_JOB_KIND } from "../jobs/kinds.ts";
import { runAgent, type RunAgentOptions } from "./runner.ts";

export { SUBAGENT_JOB_KIND };

export const DEFAULT_AGENT_MAX_USD = 0.25;
/** Longest task accepted, in UTF-8 bytes. */
export const MAX_AGENT_TASK_BYTES = 8 * 1024;
/** Wall clock a `subagent` job is enqueued with; the claim lock is extended to cover it. */
export const AGENT_JOB_TIMEOUT_MS = 600_000;

export function agentEnabled(raw: string | undefined = process.env.MEMEX_AGENT_ENABLED): boolean {
  return raw === "1";
}

/** Per-job ceiling from MEMEX_AGENT_MAX_USD; anything but a positive number is the default. */
export function agentMaxUsd(raw: string | undefined = process.env.MEMEX_AGENT_MAX_USD): number {
  const trimmed = raw?.trim() ?? "";
  const n = trimmed === "" ? Number.NaN : Number(trimmed);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_AGENT_MAX_USD;
}

export interface SubagentPayload {
  task: string;
  maxUsd: number;
}

/**
 * Validate a `subagent` payload. A job may ask for less than the operator's
 * ceiling, never more: `max_usd` is clamped to MEMEX_AGENT_MAX_USD.
 */
export function parseSubagentPayload(
  payload: Record<string, unknown>,
  ceilingUsd: number = agentMaxUsd(),
): SubagentPayload {
  const task = payload.task;
  if (typeof task !== "string" || task.trim().length === 0) {
    throw new Error("subagent: payload.task must be a non-empty string");
  }
  if (Buffer.byteLength(task, "utf8") > MAX_AGENT_TASK_BYTES) {
    throw new Error(`subagent: payload.task exceeds ${MAX_AGENT_TASK_BYTES} bytes`);
  }
  let maxUsd = ceilingUsd;
  if (payload.max_usd !== undefined) {
    const v = payload.max_usd;
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
      throw new Error("subagent: payload.max_usd must be a positive number");
    }
    maxUsd = Math.min(v, ceilingUsd);
  }
  return { task, maxUsd };
}

export type SubagentDeps = Pick<
  RunAgentOptions,
  "converse" | "dispatch" | "modelId" | "maxTurns" | "maxTokens"
>;

export function makeSubagentHandler(storage: Storage, deps: SubagentDeps = {}): JobHandler {
  return async (payload, ctx) => {
    const { task, maxUsd } = parseSubagentPayload(payload);
    const result = await runAgent({
      storage,
      job: ctx.job,
      task,
      maxUsd,
      ...(ctx.recordUsage ? { recordUsage: ctx.recordUsage } : {}),
      ...(ctx.updateProgress ? { updateProgress: ctx.updateProgress } : {}),
      ...deps,
    });
    return { ...result };
  };
}

export function registerSubagentHandler(storage: Storage, deps: SubagentDeps = {}): void {
  registerHandler(SUBAGENT_JOB_KIND, makeSubagentHandler(storage, deps));
}

/** Register the handler when MEMEX_AGENT_ENABLED=1; true when it did. */
export function registerSubagentHandlerIfEnabled(
  storage: Storage,
  raw: string | undefined = process.env.MEMEX_AGENT_ENABLED,
): boolean {
  if (!agentEnabled(raw)) return false;
  registerSubagentHandler(storage);
  return true;
}
