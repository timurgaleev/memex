/**
 * Timeline date-anchors -- deterministic, LLM-free. A page with a REAL content
 * date (documents.effective_date whose mig080 provenance is not 'fallback')
 * otherwise contributes zero timeline_events unless the opt-in chronicle
 * extractor proposes some, so the timeline event arm is blind to it. This
 * phase writes ONE anchor event per such page, at its effective_date, so
 * firmly-dated pages surface on the timeline at all.
 *
 * Design constraints:
 *   - only pages with NO existing timeline_events are anchored -- a page that
 *     already carries real events (chronicle, meetings, manual) needs no
 *     synthetic anchor, and a later real event does not collide with one;
 *   - the date comes from effective_date ONLY when its provenance is a parsed
 *     content date ('date'/'event_date'/'published'/'filename'). 'fallback'
 *     (and legacy NULL provenance) rows are skipped -- updated_at is an
 *     ingest time, never a content date, and must not become an anchor;
 *   - idempotent via the synthetic key 'date-anchor:<slug>' (the chunk-keyed
 *     dedup in addTimelineEvent), so re-runs write nothing new;
 *   - capped per run with an ordered scan: anchored pages drop out of the
 *     candidate query (they now HAVE an event), so successive runs drain the
 *     backlog resumably.
 *
 * OPT-IN (`MEMEX_TIMELINE_ANCHOR=1`, default OFF): a one-line anchor per dated
 * page is a taste call the operator confirms on their corpus first.
 */
import type { Storage } from "./storage.ts";
import { addTimelineEvent } from "./timeline.ts";
import { PAGE_MIRROR_PATH_SQL } from "./page-index.ts";

/** Cap anchors written per run (backlog drains across cycles). */
const MAX_ANCHORS_PER_RUN = 200;
/** Cap event text length (defence vs a pathological title). */
const MAX_TITLE_LEN = 200;

export interface TimelineAnchorResult {
  /** Candidate pages considered this run (dated, event-less, capped). */
  pages_scanned: number;
  /** Anchor events actually inserted this run. */
  events_written: number;
}

export function timelineAnchorEnabled(
  env: string | undefined = process.env.MEMEX_TIMELINE_ANCHOR,
): boolean {
  return env === "1";
}

interface AnchorRow {
  slug: string;
  title: string | null;
  source_id: string;
  effective_date: string;
}

export async function timelineAnchorPhase(
  storage: Storage,
): Promise<TimelineAnchorResult> {
  const result: TimelineAnchorResult = { pages_scanned: 0, events_written: 0 };
  if (!timelineAnchorEnabled()) return result;

  // Pages join their search-mirror document on the tenant-aware source_path
  // (PAGE_MIRROR_PATH_SQL binds the `p` alias). to_char renders a stable ISO
  // UTC string across engines (a driver may return timestamptz as Date or as
  // pg text, which JS Date parsing does not portably accept).
  const rows = await storage.engine().query<AnchorRow>(
    `SELECT p.slug, p.title, p.source_id,
            to_char(d.effective_date AT TIME ZONE 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS effective_date
       FROM pages p
       JOIN documents d ON d.source_path = ${PAGE_MIRROR_PATH_SQL}
      WHERE p.deleted_at IS NULL
        AND d.effective_date IS NOT NULL
        AND d.effective_date_source IS NOT NULL
        AND d.effective_date_source <> 'fallback'
        AND NOT EXISTS (
              SELECT 1 FROM timeline_events te
               WHERE te.slug = p.slug
                 AND te.source_id IS NOT DISTINCT FROM p.source_id
            )
      ORDER BY p.slug
      LIMIT ${MAX_ANCHORS_PER_RUN}`,
  );

  for (const row of rows.rows) {
    result.pages_scanned += 1;
    const title = ((row.title && row.title.trim()) || row.slug).slice(
      0,
      MAX_TITLE_LEN,
    );
    const res = await addTimelineEvent(storage, {
      slug: row.slug,
      occurred_at: row.effective_date,
      event: title,
      source_chunk_id: `date-anchor:${row.slug}`,
      // Tenant pages stamp their owning source; the 'default' tenant relies on
      // the column DEFAULT (and skips the per-write ownership probe).
      ...(row.source_id && row.source_id !== "default"
        ? { source_id: row.source_id }
        : {}),
    });
    if (res.inserted) result.events_written += 1;
  }
  return result;
}
