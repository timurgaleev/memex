/**
 * purge phase — hard-deletes content that has aged past the soft-delete TTL.
 *
 * Soft-delete (documents + pages) and archive (documents) are reversible column
 * flips; this phase is the reaper that finally frees the row once it's older
 * than `SOFT_DELETE_TTL_HOURS`. Set-based, cascades to chunks/embeddings/links
 * via FK. Idempotent: a run with nothing expired is a no-op.
 */
import type { Engine } from "../engine/interface.ts";
import {
  purgeExpiredDocuments,
  SOFT_DELETE_TTL_HOURS,
} from "../destructive-guard.ts";
import { purgeStaleVolunteerEvents } from "../context/volunteer-events.ts";

export interface PurgeResult {
  purged_documents_deleted: number;
  purged_documents_archived: number;
  purged_pages: number;
  purged_volunteer_events: number;
}

export async function purgePhase(
  engine: Engine,
  opts: { ttlHours?: number } = {},
): Promise<PurgeResult> {
  const ttlHours = opts.ttlHours ?? SOFT_DELETE_TTL_HOURS;
  const docs = await purgeExpiredDocuments(engine, ttlHours);
  // Pages purge: a page soft-deleted past the TTL is hard-removed. Its search
  // mirror (page://<slug> document) was already dropped on soft-delete, so this
  // only reaps the canonical row + its version chain (FK cascade).
  const p = await engine.query<{ slug: string }>(
    `DELETE FROM pages
      WHERE deleted_at IS NOT NULL
        AND deleted_at < NOW() - ($1 || ' hours')::interval
      RETURNING slug`,
    [String(ttlHours)],
  );
  // Telemetry GC: prune volunteer-context feedback events past their TTL.
  // Best-effort (the helper swallows its own errors), never blocks the reaper.
  const purged_volunteer_events = await purgeStaleVolunteerEvents(engine);
  return {
    purged_documents_deleted: docs.purged_deleted,
    purged_documents_archived: docs.purged_archived,
    purged_pages: p.rows.length,
    purged_volunteer_events,
  };
}
