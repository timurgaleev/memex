/**
 * pages-purge — the manual escape hatch for hard-deleting soft-deleted pages.
 *
 * memex soft-deletes pages by flipping `pages.deleted_at` (core/pages.ts
 * deletePage); the row + its append-only `page_versions` chain are kept so a
 * delete is reversible (page_restore). This module is the reaper that finally
 * frees a row once it has aged past `older_than_hours`, cascading to
 * page_versions / page_aliases / links via the FK ON DELETE CASCADE declared in
 * migrations 015 / 016 / 034.
 *
 * It is the same set-based DELETE the autopilot `purge` cycle phase
 * (core/cycle/purge.ts) runs, lifted into a standalone, parameterized helper so
 * an operator can trigger it on demand and see WHICH slugs were reaped. The
 * page search mirror (page://<slug>) was already dropped at soft-delete time, so
 * this only removes the canonical row + its history.
 */
import type { Engine } from "./engine/interface.ts";
import { SOFT_DELETE_TTL_HOURS } from "./destructive-guard.ts";

export interface PurgeDeletedPagesResult {
  /** Number of pages hard-deleted. */
  count: number;
  /** The slugs that were reaped (for the operator's audit). */
  slugs: string[];
}

/**
 * Hard-delete pages whose `deleted_at` is older than `olderThanHours`.
 * Idempotent: a run with nothing expired returns count 0. Defaults to the
 * shared soft-delete TTL (72h) when no cutoff is given.
 */
export async function purgeDeletedPages(
  engine: Engine,
  olderThanHours: number = SOFT_DELETE_TTL_HOURS,
  sourceIds?: string[],
): Promise<PurgeDeletedPagesResult> {
  // Tenant write scope (mig047): when a non-empty scope is given, the reaper
  // only frees rows owned by it — a scoped caller can never purge another
  // tenant's soft-deleted pages. Unset/empty → whole-brain, unchanged.
  const params: unknown[] = [String(olderThanHours)];
  let sourceFilter = "";
  if (sourceIds && sourceIds.length > 0) {
    params.push(sourceIds);
    sourceFilter = ` AND source_id = ANY($${params.length}::text[])`;
  }
  const r = await engine.query<{ slug: string }>(
    `DELETE FROM pages
      WHERE deleted_at IS NOT NULL
        AND deleted_at < NOW() - ($1 || ' hours')::interval${sourceFilter}
      RETURNING slug`,
    params,
  );
  const slugs = r.rows.map((row) => row.slug);
  return { count: slugs.length, slugs };
}
