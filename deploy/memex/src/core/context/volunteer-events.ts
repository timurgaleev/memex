/**
 * context_volunteer_events — the feedback-loop log behind push-based context
 * (migration 044). One row per page the brain VOLUNTEERED, written
 * fire-and-forget by the volunteer_context op and `memex watch` (channel
 * 'op' / 'watch').
 *
 * "Used" is DERIVED, never written: a volunteered page counts as used when
 * `pages.last_retrieved_at > volunteered_at`. The join is approximate by
 * design (see volunteer.ts VOLUNTEER_STATS_NOTE).
 *
 * Retention: rows older than VOLUNTEER_EVENTS_TTL_DAYS are pruned by the
 * cycle's purge phase (purgeStaleVolunteerEvents). `rationale` is a
 * deterministic template that may embed the matched entity's surface form
 * (which by construction resolved to an existing alias/title/slug) — never free
 * conversation text.
 *
 * memex adaptation: no source_id federation (flat vault); source_id is written
 * NULL. Fire-and-forget is a self-contained tracked-promise set (memex has no
 * shared background-work registry); callers drain it via
 * awaitPendingVolunteerEventWrites before teardown.
 */

import type { Storage } from "../storage.ts";
import type { Engine } from "../engine/interface.ts";

export const VOLUNTEER_EVENTS_TTL_DAYS = 90;

export type VolunteerChannel = "op" | "reflex" | "watch";

export interface VolunteerEventRow {
  slug: string;
  confidence: number;
  match_arm: string;
  rationale: string;
  channel: VolunteerChannel;
  session_id?: string | null;
  turn?: number | null;
}

/**
 * Map volunteered pages to event rows for one channel — the ONE place the
 * VolunteerEventRow shape is assembled (op / watch both call this, so adding a
 * column is a one-site change).
 */
export function volunteerEventRowsFrom(
  pages: Array<{ slug: string; confidence: number; arm: string; rationale: string }>,
  opts: { channel: VolunteerChannel; session_id?: string | null; turn?: number | null },
): VolunteerEventRow[] {
  return pages.map((p) => ({
    slug: p.slug,
    confidence: p.confidence,
    match_arm: p.arm,
    rationale: p.rationale,
    channel: opts.channel,
    session_id: opts.session_id ?? null,
    turn: opts.turn ?? null,
  }));
}

/**
 * ONE multi-row parameterized INSERT for a batch of volunteered pages (max 5
 * per call by the volunteer cap) — never per-row awaited INSERTs. Throws on
 * failure; callers run it through the fire-and-forget sink with try/catch so
 * logging can never fail the op.
 */
export async function insertVolunteerEvents(
  storage: Storage,
  rows: VolunteerEventRow[],
): Promise<void> {
  if (!rows.length) return;
  const params: unknown[] = [];
  const tuples = rows.map((r) => {
    const base = params.length;
    // source_id is always NULL in memex (flat vault) — written explicitly so
    // the column order matches the table and stays parity-shaped.
    params.push(
      null,
      r.slug,
      r.confidence,
      r.match_arm,
      r.rationale,
      r.channel,
      r.session_id ?? null,
      r.turn ?? null,
    );
    const ph = Array.from({ length: 8 }, (_, i) => `$${base + i + 1}`);
    return `(${ph.join(", ")})`;
  });
  await storage.engine().query(
    `INSERT INTO context_volunteer_events
       (source_id, slug, confidence, match_arm, rationale, channel, session_id, turn)
     VALUES ${tuples.join(", ")}`,
    params,
  );
}

// -- Fire-and-forget sink -------------------------------------------------

const pendingVolunteerEventWrites = new Set<Promise<unknown>>();

/**
 * Log volunteered pages without blocking the hot path. The batched INSERT runs
 * as a tracked dangling promise; errors are swallowed (pre-044 brains,
 * transient DB failures — the volunteer result is unaffected).
 */
export function logVolunteerEventsFireAndForget(
  storage: Storage,
  rows: VolunteerEventRow[],
): void {
  if (!rows.length) return;
  const p = insertVolunteerEvents(storage, rows).catch(() => {
    /* best-effort telemetry — never surfaces */
  });
  pendingVolunteerEventWrites.add(p);
  void p.finally(() => pendingVolunteerEventWrites.delete(p));
}

/** Drain pending event writes (bounded). */
export async function awaitPendingVolunteerEventWrites(
  timeoutMs = 5_000,
): Promise<{ unfinished: number }> {
  if (pendingVolunteerEventWrites.size === 0) return { unfinished: 0 };
  const snapshot = Array.from(pendingVolunteerEventWrites);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(resolve, timeoutMs, "timeout");
  });
  const drain = Promise.allSettled(snapshot).then(() => "drained" as const);
  const outcome = await Promise.race([drain, timeout]);
  if (timer) clearTimeout(timer);
  if (outcome === "timeout") {
    const unfinished = pendingVolunteerEventWrites.size;
    // Drop the snapshot so a long-lived process (`memex watch`) doesn't
    // accumulate references to forever-pending work.
    for (const p of snapshot) pendingVolunteerEventWrites.delete(p);
    return { unfinished };
  }
  return { unfinished: 0 };
}

/** Test seam — clears the pending set so each test starts clean. */
export function _resetPendingVolunteerEventWritesForTests(): void {
  pendingVolunteerEventWrites.clear();
}

/** Test seam — peek the current pending count. */
export function _peekPendingVolunteerEventWritesForTests(): number {
  return pendingVolunteerEventWrites.size;
}

/**
 * 90-day GC, called from the cycle's purge phase. Best-effort: returns 0 on any
 * failure (pre-044 brains have no table yet).
 */
export async function purgeStaleVolunteerEvents(
  engine: Engine,
  ttlDays = VOLUNTEER_EVENTS_TTL_DAYS,
): Promise<number> {
  try {
    const r = await engine.query<{ count: string | number }>(
      `WITH deleted AS (
         DELETE FROM context_volunteer_events
         WHERE volunteered_at < now() - ($1 || ' days')::interval
         RETURNING 1
       )
       SELECT count(*)::text AS count FROM deleted`,
      [String(ttlDays)],
    );
    return Number(r.rows[0]?.count ?? 0);
  } catch {
    return 0;
  }
}
