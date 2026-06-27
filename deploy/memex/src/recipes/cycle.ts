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
import {
  tryAcquireDbLock,
  reapDeadHolderLocks,
  CYCLE_LOCK_ID,
  type DbLockHandle,
} from "../core/db-lock.ts";

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

// Phases skipped during quiet hours. embed-stale calls Bedrock; mirror-pages
// re-embeds stale/missing page mirrors (also Bedrock); extract-timeline (when
// MEMEX_MEETING_TIMELINE=1) is a replace-own-projection that re-derives every
// meeting's events, so it is write-heavy on a meeting-rich vault.
const COSTLY_PHASES: ReadonlySet<PhaseName> = new Set([
  "embed-stale",
  "mirror-pages",
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
  // The lock held by an in-flight tick, tracked at loop scope so a graceful
  // stop() can release it deterministically — otherwise a SIGTERM landing
  // mid-tick (every deploy) would abandon the tick's `finally` and strand the
  // lock until the TTL lapses. `null` between ticks.
  let currentLock: DbLockHandle | null = null;

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

    // Background sweep: reclaim a `memex-cycle` lock stranded by a holder that
    // crashed (OOM/SIGKILL) on THIS host, so a dead row never blocks a tick for
    // the full TTL. tryAcquireDbLock only reclaims on contention; this is the
    // proactive sweep. Best-effort — never let it abort the tick.
    try {
      await reapDeadHolderLocks(storage.engine());
    } catch {
      /* best-effort sweep */
    }

    // Cross-process guard: another daemon (or a manual `cycle` run) may already
    // be working this brain. The DB lock serializes the maintenance pipeline so
    // two cycles don't fight over the same phases. A null handle means a live
    // holder owns the lock — skip this tick and re-arm the next one.
    const lock = await tryAcquireDbLock(storage.engine(), CYCLE_LOCK_ID, 30);
    if (!lock) {
      console.log(`[cycle] tick skipped: another holder owns ${CYCLE_LOCK_ID}`);
    } else {
      currentLock = lock;
      // Heartbeat: refresh the lock every ~TTL/3 (10 min for the 30 min TTL) so
      // a long run (a heavy embed-stale pass over a large vault) cannot outlive
      // the TTL + steal-grace and let a second cycle acquire concurrently. The
      // refresh is fire-and-forget; a transient failure self-heals next tick and
      // the TTL stays the backstop. unref so the timer never pins the event loop.
      const refresher = setInterval(
        () => {
          void lock.refresh().catch(() => {});
        },
        10 * 60 * 1000,
      );
      (refresher as unknown as { unref?: () => void }).unref?.();
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
      } finally {
        clearInterval(refresher);
        try {
          await lock.release();
        } catch {
          /* idempotent — lock will auto-expire under TTL */
        }
        currentLock = null;
      }
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
      // Release a lock held by an in-flight tick BEFORE the caller closes the
      // engine (serve's shutdown does `await cycle.stop()` then `storage.close()`).
      // The tick's own `finally` would otherwise race the engine close. Idempotent
      // with that `finally`; either order leaves the row deleted. NOTE: this does
      // NOT await the in-flight tick — it releases the lock while the tick may
      // still be running, which is safe ONLY because the sole caller (serve's
      // shutdown) closes the engine and exits immediately after. In a keep-alive
      // context this would let a competitor acquire mid-work; don't reuse it so.
      if (currentLock) {
        try {
          await currentLock.release();
        } catch {
          /* idempotent — TTL is the backstop */
        }
        currentLock = null;
      }
    },
  };
}
