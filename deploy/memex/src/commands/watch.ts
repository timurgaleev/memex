/**
 * `memex watch [--json] [--window-turns N] [--max-pages N] [--min-confidence X]`
 *
 * Push-based context transport (Wave-3 parity). Reads conversation turns from
 * stdin AS THEY ARRIVE (plain text = a user turn; `user:` / `assistant:`
 * prefixed lines set the role), maintains a rolling window in-process, and
 * volunteers confidence-gated brain pages to stdout after every turn. The
 * consumer pipes its transcript in and reads volunteered pointers out — no
 * per-entity CLI round-trips.
 *
 * Lifecycle: BLOCKS in the stdin iteration. Piped input exits at EOF; an
 * interactive TTY stays alive until Ctrl-C / Ctrl-D. SIGINT closes the stream
 * so the for-await ends and the drain-then-exit path runs (never a mid-write
 * kill). Volunteer-event writes are drained before the handler returns.
 *
 * Session dedupe: a slug is volunteered at most once per session — already-
 * pushed slugs ride VolunteerOpts.excludeSlugs, skipped inside the core's
 * pointer loop BEFORE the confidence gate and the cap (O(1) membership; a
 * post-call filter would let a recurring entity starve new pages out of the
 * cap).
 *
 * IO is injectable (`WatchDeps`) for offline tests: pass a `lines` async
 * iterable + a `write` sink + a `storage` to drive the loop without stdin or a
 * real config.
 */

import { createInterface } from "node:readline";
import { Storage } from "../core/storage.ts";
import { loadConfig } from "../core/config.ts";
import {
  volunteerContext,
  formatVolunteeredPage,
  TURN_PREFIX_RE,
  VOLUNTEER_DEFAULT_MAX_PAGES,
  VOLUNTEER_DEFAULT_MIN_CONFIDENCE,
} from "../core/context/volunteer.ts";
import type { WindowTurn } from "../core/context/entity-salience.ts";
import {
  logVolunteerEventsFireAndForget,
  volunteerEventRowsFrom,
  awaitPendingVolunteerEventWrites,
} from "../core/context/volunteer-events.ts";

/** Default extraction window (turns). */
export const DEFAULT_WINDOW_TURNS = 4;
/** Hard cap — an unbounded window re-scans every retained turn every turn. */
const MAX_WINDOW_TURNS = 64;

export interface WatchOptions {
  json?: boolean;
  windowTurns?: number;
  maxPages?: number;
  minConfidence?: number;
}

export interface WatchDeps {
  /** Injected storage (tests). When omitted, opens from loadConfig(). */
  storage?: Storage;
  /** Injected line source (tests). Defaults to readline over stdin. */
  lines?: AsyncIterable<string>;
  /** Output sink (tests). Defaults to process.stdout. */
  write?: (s: string) => void;
  /** Whether the session is interactive (tests). Defaults to stdin.isTTY. */
  isTTY?: boolean;
}

function clampWindowTurns(n: number | undefined): number {
  const v = typeof n === "number" && Number.isFinite(n) ? Math.floor(n) : DEFAULT_WINDOW_TURNS;
  return Math.min(MAX_WINDOW_TURNS, Math.max(1, v));
}

export async function runWatch(
  opts: WatchOptions = {},
  deps: WatchDeps = {},
): Promise<void> {
  const json = opts.json ?? false;
  const windowTurns = clampWindowTurns(opts.windowTurns);
  const write = deps.write ?? ((s: string) => process.stdout.write(s));
  const isTTY = deps.isTTY ?? Boolean(process.stdin.isTTY);

  const ownStorage = !deps.storage;
  const storage = deps.storage ?? new Storage(loadConfig());
  if (ownStorage) await storage.init();

  const sessionId = `watch-${process.pid}-${Date.now().toString(36)}`;

  if (!deps.lines) {
    // The ready line doubles as a machine-readable readiness signal.
    process.stderr.write(
      isTTY
        ? `[watch] interactive session ${sessionId} ready - type turns ('assistant: ...' to set role), Ctrl-C to end\n`
        : `[watch] session ${sessionId} ready\n`,
    );
  }

  const rl = deps.lines
    ? null
    : createInterface({ input: process.stdin, crlfDelay: Infinity });
  const lines: AsyncIterable<string> = deps.lines ?? (rl as AsyncIterable<string>);

  // SIGINT closes the stream so the for-await ends and the normal
  // drain-then-exit path runs (never a mid-write kill).
  const onSigint = () => {
    rl?.close();
  };
  process.on("SIGINT", onSigint);

  const window: WindowTurn[] = [];
  const pushedSlugs = new Set<string>(); // session dedupe
  let turnNo = 0;

  try {
    for await (const rawLine of lines) {
      const line = rawLine.replace(/\r$/, "");
      if (!line.trim()) continue;
      const m = TURN_PREFIX_RE.exec(line);
      const turn: WindowTurn = m
        ? { role: (m[1] ?? "user").toLowerCase() as WindowTurn["role"], text: (m[2] ?? "").trim() }
        : { role: "user", text: line.trim() };
      if (!turn.text) continue;
      turnNo++;
      window.push(turn);
      if (window.length > windowTurns) {
        window.splice(0, window.length - windowTurns);
      }

      let pages;
      try {
        pages = await volunteerContext(storage, {
          window: [...window],
          maxPages: opts.maxPages,
          minConfidence: opts.minConfidence,
          excludeSlugs: pushedSlugs,
        });
      } catch {
        continue; // fail-open per turn: a transient DB error never kills the stream
      }
      if (!pages.length) continue;

      for (const p of pages) pushedSlugs.add(p.slug);
      logVolunteerEventsFireAndForget(
        storage,
        volunteerEventRowsFrom(pages, { channel: "watch", session_id: sessionId, turn: turnNo }),
      );

      if (json) {
        for (const p of pages) write(JSON.stringify({ turn: turnNo, ...p }) + "\n");
      } else {
        for (const p of pages) write(formatVolunteeredPage(p) + "\n");
      }
    }
  } finally {
    process.off("SIGINT", onSigint);
    rl?.close();
    // Bank pending event writes before teardown (mirrors the op path).
    await awaitPendingVolunteerEventWrites();
    if (ownStorage) await storage.close();
  }
}

export const WATCH_HELP = `memex watch - push-based context: volunteer brain pages per conversation turn

Reads turns from stdin (one per line; 'user:' / 'assistant:' prefixes set the
role, unprefixed lines are user turns) and prints confidence-gated page
pointers with rationales after each turn. A slug is volunteered at most once
per session. Piped input exits at EOF; interactive sessions exit on Ctrl-C.

Usage:
  some-transcript-feed | memex watch [--json]
  memex watch                          # interactive: type turns, Ctrl-C to end

Flags:
  --json                 JSONL output (one volunteered page per line)
  --window-turns N       rolling extraction window (default ${DEFAULT_WINDOW_TURNS}, cap ${MAX_WINDOW_TURNS})
  --max-pages N          max pages volunteered per turn (default ${VOLUNTEER_DEFAULT_MAX_PAGES}, cap 5)
  --min-confidence X     confidence gate 0..1 (default ${VOLUNTEER_DEFAULT_MIN_CONFIDENCE})
  --help                 this text
`;
