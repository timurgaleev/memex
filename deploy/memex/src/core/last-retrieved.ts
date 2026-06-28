/**
 * `pages.last_retrieved_at` write-back — the missing PRODUCER for the retrieval
 * signal migration 024 added and the context-volunteer "used" precision stat
 * (core/context/volunteer.ts) CONSUMES. The column + consumer shipped without a
 * producer, so `last_retrieved_at` stayed NULL and the volunteer `used` count
 * was structurally always 0. This bumps it when a user-facing op surfaces a page.
 *
 * Faithful adaptation of the reference's `bumpLastRetrievedAt`, with two stack
 * adaptations:
 *  - keyed on the `slug` PK (the reference uses a numeric page id); the
 *    volunteer consumer joins on slug, so this matches it.
 *  - the reference is fire-and-forget + a CLI drain helper (PGLite hung on
 *    dangling promises raced by `disconnect()`). memex is single-holder / low
 *    QPS, so the op-handler simply AWAITS this throttled best-effort UPDATE —
 *    negligible added latency, and it sidesteps the dangling-promise hang
 *    entirely instead of porting the drain/background-work-sink apparatus.
 *
 * Best-effort: any error (column missing on a pre-mig-024 brain, statement
 * timeout, blip) is swallowed with a warn — the op result is never affected.
 * Default-on; `MEMEX_TRACK_RETRIEVAL=0` opts out (the reference's
 * `search.track_retrieval` config escape hatch, as a memex env flag).
 */
import type { Engine } from "./engine/interface.ts";

/**
 * Per the reference's D2 throttle — collapse repeat surfaces within 5 min.
 * Precision trade-off (accepted; the "used" stat is labelled approximate):
 * a page retrieved <5 min BEFORE it is volunteered and re-retrieved just after
 * has its second (genuine post-volunteer) retrieval throttled away, so the
 * volunteer "used" join can under-count it. Bounded by this window.
 */
const THROTTLE = "5 minutes";

/**
 * Bump `last_retrieved_at = NOW()` for the surfaced page slugs. AWAIT this in
 * the op handler (it never throws). Empty list / opt-out / failure are no-ops.
 * The throttle WHERE clause keeps a hot page from piling up MVCC row versions.
 *
 * `sourceId` scopes the UPDATE to one owning source (mig-047 pre-emption, same
 * as `stampLinksExtracted`): under today's slug PK it is redundant, but once the
 * composite `(source_id, slug)` PK lands a source-blind UPDATE would over-stamp
 * a sibling source's same-slug page. (The consumer's slug-only join in
 * `context/volunteer.ts` carries the matching latent assumption — see TODO.)
 */
export async function bumpLastRetrievedAt(
  engine: Engine,
  slugs: string[],
  sourceId?: string,
): Promise<void> {
  if (slugs.length === 0) return;
  if (process.env.MEMEX_TRACK_RETRIEVAL === "0") return;
  const params: unknown[] = [slugs];
  let scopeFilter = "";
  if (typeof sourceId === "string" && sourceId.length > 0) {
    params.push(sourceId);
    scopeFilter = ` AND source_id = $${params.length}`;
  }
  try {
    await engine.query(
      `UPDATE pages
          SET last_retrieved_at = NOW()
        WHERE slug = ANY($1::text[])
          AND deleted_at IS NULL${scopeFilter}
          AND (last_retrieved_at IS NULL
               OR last_retrieved_at < NOW() - INTERVAL '${THROTTLE}')`,
      params,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[last-retrieved] write-back failed (best-effort): ${msg}`);
  }
}
