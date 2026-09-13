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
 * The autopilot `purge` cycle phase (core/cycle/purge.ts) runs the same helper
 * unscoped; an operator can also trigger it on demand and see WHICH slugs were
 * reaped. The
 * page search mirror (page://<slug>) was already dropped at soft-delete time, so
 * this only removes the canonical row + its history.
 */
import type { Engine } from "./engine/interface.ts";
import { SOFT_DELETE_TTL_HOURS } from "./destructive-guard.ts";
import { andSourceScope } from "./source-scope.ts";

export interface PurgeDeletedPagesResult {
  /** Number of pages hard-deleted. */
  count: number;
  /** The slugs that were reaped (for the operator's audit). */
  slugs: string[];
  /** Expired pages still referenced by a row that does not cascade; left in place. */
  blocked: Array<{ slug: string; reason: string }>;
}

const FOREIGN_KEY_VIOLATION = "23503";

/**
 * Hard-delete pages whose `deleted_at` is older than `olderThanHours`.
 * Idempotent: a run with nothing expired returns count 0. Defaults to the
 * shared soft-delete TTL (72h) when no cutoff is given.
 *
 * A set-based DELETE aborts the whole sweep when any one page is still
 * referenced, so on a foreign-key violation it falls back to one DELETE per page:
 * a blocked page is reported and the other expired pages still go.
 */
export async function purgeDeletedPages(
  engine: Engine,
  olderThanHours: number = SOFT_DELETE_TTL_HOURS,
  sourceIds?: string[],
): Promise<PurgeDeletedPagesResult> {
  // Tenant write scope (mig047): when a scope is given, the reaper only frees
  // rows owned by it — a scoped caller can never purge another tenant's
  // soft-deleted pages, and an empty grant purges nothing. Unset → whole-brain.
  const params: unknown[] = [String(olderThanHours)];
  const sourceFilter = andSourceScope("source_id", sourceIds, params);
  const expiredWhere = `deleted_at IS NOT NULL
        AND deleted_at < NOW() - ($1 || ' hours')::interval${sourceFilter}`;
  // Fast path: one set-based DELETE. Every table referencing pages cascades
  // today, so this almost always succeeds.
  try {
    const r = await engine.query<{ slug: string }>(
      `DELETE FROM pages WHERE ${expiredWhere} RETURNING slug`,
      params,
    );
    return { count: r.rows.length, slugs: r.rows.map((row) => row.slug).sort(), blocked: [] };
  } catch (err) {
    if ((err as { code?: string })?.code !== FOREIGN_KEY_VIOLATION) throw err;
  }
  // Slow path, reached only when some expired page is still referenced by a
  // row that does not cascade: one DELETE per page so the stuck ones are
  // reported and the rest still go. Each statement commits on its own — this
  // must not run inside a transaction, where the first violation aborts it.
  const expired = await engine.query<{ slug: string }>(
    `SELECT slug FROM pages WHERE ${expiredWhere} ORDER BY slug`,
    params,
  );
  const slugs: string[] = [];
  const blocked: Array<{ slug: string; reason: string }> = [];
  for (const { slug } of expired.rows) {
    try {
      // Same predicate again: a restore or a move between the scan and this row
      // keeps the page.
      const rowParams: unknown[] = [String(olderThanHours), slug];
      const rowFilter = andSourceScope("source_id", sourceIds, rowParams);
      const r = await engine.query<{ slug: string }>(
        `DELETE FROM pages
          WHERE slug = $2 AND deleted_at IS NOT NULL
            AND deleted_at < NOW() - ($1 || ' hours')::interval${rowFilter}
          RETURNING slug`,
        rowParams,
      );
      if (r.rows.length > 0) slugs.push(slug);
    } catch (err) {
      if ((err as { code?: string })?.code !== FOREIGN_KEY_VIOLATION) throw err;
      blocked.push({ slug, reason: "still referenced by a row that does not cascade" });
    }
  }
  return { count: slugs.length, slugs, blocked };
}
