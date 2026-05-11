/**
 * System-load throttle / preflight.
 *
 * Distinct from `core/jobs/backoff.ts` (which schedules retries after
 * a job fails). This module gates *new* heavy operations — the typical
 * caller is "about to launch a Bedrock embed batch, should I?" — based
 * on:
 *
 *   - 1-minute load average (Linux/macOS only; Windows reports 0).
 *   - Resident-set-size of the current process.
 *   - In-memory counter of concurrently throttled operations.
 *   - Optional quiet-hours gate (so a sweep doesn't fight the
 *     morning briefing); window is configurable.
 *
 * Stays in-process: there's no shared state between containers. That's
 * fine for our single-EC2 deployment; if we ever scale out we'd swap
 * the counter for an RDS row with `FOR UPDATE`.
 */
import { loadavg } from "node:os";
import { inQuietHours, type QuietWindow } from "./jobs/quiet-hours.ts";

export interface ThrottleConfig {
  /** 1-minute load average ceiling. Default 4. */
  maxLoad: number;
  /** Process RSS ceiling (MB). Default 800 — half of t4g.medium RAM. */
  maxMemoryMB: number;
  /** Simultaneous throttled operations. Default 2. */
  maxConcurrent: number;
  /** Decline proceed inside the configured quiet-hours window. Default true. */
  respectQuietHours: boolean;
  /** Override the quiet-hours window (tests). */
  quietWindow?: QuietWindow;
  /** Override "now" (tests). */
  now?: Date;
  /** Override loadavg / RSS (tests). */
  systemSensors?: {
    loadAvg1?: number;
    memoryRssMB?: number;
  };
}

const DEFAULTS: ThrottleConfig = {
  maxLoad: 4,
  maxMemoryMB: 800,
  maxConcurrent: 2,
  respectQuietHours: true,
};

export type ThrottleReason =
  | "load"
  | "memory"
  | "concurrent"
  | "quiet-hours"
  | null;

export interface ThrottleState {
  load: number;
  memoryUsedMB: number;
  activeProcesses: number;
  inQuietHours: boolean;
  /** Names of currently-active processes — useful for `getThrottleState`. */
  activeNames: string[];
}

export interface ThrottleResult {
  proceed: boolean;
  reason: ThrottleReason;
  state: ThrottleState;
}

// Module-private counter. `_resetForTest` zeroes it.
const ACTIVE = new Map<string, number>();

function readState(opts: Partial<ThrottleConfig> = {}): ThrottleState {
  const sensors = opts.systemSensors ?? {};
  const load1 =
    sensors.loadAvg1 ?? (typeof loadavg === "function" ? loadavg()[0]! : 0);
  const memMB =
    sensors.memoryRssMB ?? Math.round(process.memoryUsage().rss / 1024 / 1024);
  const now = opts.now ?? new Date();
  const respectQuiet = opts.respectQuietHours ?? DEFAULTS.respectQuietHours;
  const inWindow = respectQuiet
    ? inQuietHours(now, opts.quietWindow)
    : false;
  const activeProcesses = Array.from(ACTIVE.values()).reduce(
    (s, n) => s + n,
    0,
  );
  const activeNames = Array.from(ACTIVE.keys()).sort();
  return {
    load: load1,
    memoryUsedMB: memMB,
    activeProcesses,
    inQuietHours: inWindow,
    activeNames,
  };
}

/**
 * Non-blocking check. Use it from a code path that has a sensible
 * fallback when the throttle declines (e.g. "skip this sweep cycle,
 * try again next tick").
 */
export function shouldProceed(
  opts: Partial<ThrottleConfig> = {},
): ThrottleResult {
  const cfg: ThrottleConfig = { ...DEFAULTS, ...opts };
  const state = readState(opts);

  let reason: ThrottleReason = null;
  if (cfg.respectQuietHours && state.inQuietHours) reason = "quiet-hours";
  else if (state.activeProcesses >= cfg.maxConcurrent) reason = "concurrent";
  else if (state.load > cfg.maxLoad) reason = "load";
  else if (state.memoryUsedMB > cfg.maxMemoryMB) reason = "memory";

  return { proceed: reason === null, reason, state };
}

export interface WaitOptions {
  /** Max ms to wait. Default 60_000. */
  timeoutMs?: number;
  /** Poll interval ms. Default 1_000. */
  pollMs?: number;
}

/**
 * Block until `shouldProceed` is true or the timeout elapses. Throws
 * on timeout — the caller is signalling that the operation can't
 * silently skip, so a hard fail is the right contract.
 */
export async function waitForCapacity(
  opts: Partial<ThrottleConfig> = {},
  waitOpts: WaitOptions = {},
): Promise<void> {
  const timeout = waitOpts.timeoutMs ?? 60_000;
  const poll = waitOpts.pollMs ?? 1_000;
  const deadline = Date.now() + timeout;
  for (;;) {
    const r = shouldProceed(opts);
    if (r.proceed) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `waitForCapacity: timeout after ${timeout}ms (last reason=${r.reason}, state=${JSON.stringify(r.state)})`,
      );
    }
    await sleep(poll);
  }
}

/**
 * Pre-check + slot-grab. If the throttle accepts, increments the
 * active counter under `processName` and returns true; the caller
 * MUST call `complete(processName)` when the operation finishes.
 * If the throttle declines, returns false and leaves the counter
 * untouched.
 */
export function preflight(
  processName: string,
  opts: Partial<ThrottleConfig> = {},
): ThrottleResult {
  if (!processName || typeof processName !== "string") {
    throw new Error("preflight: processName is required");
  }
  const r = shouldProceed(opts);
  if (r.proceed) {
    ACTIVE.set(processName, (ACTIVE.get(processName) ?? 0) + 1);
    // Refresh the state so the caller sees the post-grab counter.
    return {
      proceed: true,
      reason: null,
      state: readState(opts),
    };
  }
  return r;
}

/**
 * Release a slot acquired via `preflight`. No-op if the name has no
 * active count — defensive against double-complete.
 */
export function complete(processName: string): void {
  const cur = ACTIVE.get(processName) ?? 0;
  if (cur <= 1) ACTIVE.delete(processName);
  else ACTIVE.set(processName, cur - 1);
}

export function getThrottleState(
  opts: Partial<ThrottleConfig> = {},
): ThrottleState {
  return readState(opts);
}

/** Test-only — zero the counter between cases. */
export function _resetForTest(): void {
  ACTIVE.clear();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
