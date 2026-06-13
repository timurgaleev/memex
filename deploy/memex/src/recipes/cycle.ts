/**
 * Cycle loop recipe — replaces the old dream.ts.
 *
 * Periodically runs `core/cycle/runCycleOnce()` (the 6-phase maintenance
 * pipeline). Honours quiet hours so it doesn't fight interactive MCP
 * recall traffic for CPU. Skips embed-stale during quiet hours but still
 * runs the cheap read-only phases (reconcile-links, snapshot) — those are
 * useful state even during a quiet-hours window.
 */
import type { Storage } from "../core/storage.ts";
import {
  ALL_PHASES,
  runCycleOnce,
  type CycleOptions,
  type PhaseName,
} from "../core/cycle/index.ts";
import { consoleProgress } from "../core/output/progress.ts";

export interface CycleLoopOptions {
  /** Interval between ticks, ms. */
  intervalMs: number;
  /** Forwarded to embed-stale. Default 30. */
  staleDays?: number;
  /** Inclusive quiet-hour start in the configured zone (default 6). */
  quietStartHour?: number;
  /** Exclusive quiet-hour end in the configured zone (default 8). */
  quietEndHour?: number;
}

export interface CycleHandle {
  stop: () => Promise<void>;
}

const DEFAULT_QUIET_START = 6;
const DEFAULT_QUIET_END = 8;

// Phases skipped during quiet hours. embed-stale calls Bedrock; extract-timeline
// (when MEMEX_MEETING_TIMELINE=1) is a replace-own-projection that re-derives
// every meeting's events, so it is write-heavy on a meeting-rich vault.
const COSTLY_PHASES: ReadonlySet<PhaseName> = new Set([
  "embed-stale",
  "embed-facts",
  "extract-timeline",
]);

function isInQuietHours(
  now: Date,
  startHour: number,
  endHour: number,
): boolean {
  const berlinHourStr = now.toLocaleString("en-GB", {
    timeZone: "Europe/Berlin",
    hour: "2-digit",
    hour12: false,
  });
  const hour = Number(berlinHourStr);
  if (!Number.isFinite(hour)) return false;
  if (startHour < endHour) return hour >= startHour && hour < endHour;
  return hour >= startHour || hour < endHour;
}

export function startCycleLoop(
  storage: Storage,
  options: CycleLoopOptions,
): CycleHandle {
  const quietStart = options.quietStartHour ?? DEFAULT_QUIET_START;
  const quietEnd = options.quietEndHour ?? DEFAULT_QUIET_END;
  const staleDays = options.staleDays ?? 30;

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const runTick = async (): Promise<void> => {
    if (stopped) return;
    const now = new Date();
    const inQuiet = isInQuietHours(now, quietStart, quietEnd);
    const phases: PhaseName[] = inQuiet
      ? ALL_PHASES.filter((p) => !COSTLY_PHASES.has(p))
      : [...ALL_PHASES];

    const opts: CycleOptions = {
      phases,
      staleDays,
      progress: consoleProgress("cycle"),
      storage,
    };

    try {
      const r = await runCycleOnce(storage.engine(), opts);
      const mark = (s: string) => (s === "fail" ? "FAIL" : s); // ok | warn | FAIL
      const summary = r.phases
        .map((p) => `${p.phase}=${mark(p.status)}`)
        .join(" ");
      console.log(
        `[cycle] tick status=${mark(r.status)} ${summary} duration=${
          new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime()
        }ms${inQuiet ? " (quiet — embed-stale skipped)" : ""}`,
      );
    } catch (e) {
      console.warn(
        `[cycle] tick failed:`,
        e instanceof Error ? e.message : e,
      );
    }
    if (!stopped) {
      timer = setTimeout(runTick, options.intervalMs);
    }
  };

  // First tick deferred by one interval so daemon boot has CPU headroom.
  timer = setTimeout(runTick, options.intervalMs);

  return {
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
