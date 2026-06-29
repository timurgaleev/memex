/**
 * frontmatter-inference phase — fill in missing frontmatter for documents
 * that have an empty {} object.
 *
 * Heuristics (no LLM — cheap, deterministic):
 *   - `title` from first H1 if absent (already handled at index time;
 *      retroactive for older rows that pre-date H1 detection).
 *   - `tags` inferred from `#hashtags` in body if frontmatter has none.
 *   - `created`, `updated` mirrored from documents.ingested_at /
 *      updated_at if absent.
 *
 * Mutates `documents.frontmatter` in place. Idempotent: a document
 * whose frontmatter already has all keys is a no-op.
 */
import type { Engine } from "../engine/interface.ts";
import { extractHashtags } from "../entities.ts";
import { wellFormJsonbValue } from "../well-form.ts";
import { bumpDocumentClock } from "../generation.ts";

export interface FrontmatterInferenceResult {
  scanned: number;
  updated: number;
  fields_added: { title: number; tags: number; created: number; updated: number };
}

interface DocRow {
  id: string;
  source_path: string;
  title: string | null;
  frontmatter: Record<string, unknown> | null;
  ingested_at: string;
  updated_at: string;
  body_sample: string;
}

// Keyset batch size. The reference infers frontmatter ONE file at a time
// (streaming the disk walk — `inferFrontmatter(path, content)` is pure over a
// single doc, never the whole corpus). memex's DB phase originally materialised
// EVERY doc + its chunk-0 content in one query, which on the small live host
// spiked anon memory enough to OOM-kill (SIGKILL) the cycle process at this
// phase's start. Keyset-paginate to match the reference's bounded iteration:
// peak memory is O(FM_BATCH rows), not O(corpus). Override via MEMEX_CYCLE_FM_BATCH.
const FM_BATCH = Math.max(1, Number(process.env.MEMEX_CYCLE_FM_BATCH) || 100);

// Cap the per-doc content pulled for hashtag inference. Hashtags live early;
// loading a multi-MB chunk-0 per row would turn a bounded batch back into an
// unbounded load. The reference reads file content per-file; this is the DB
// analogue of not slurping a giant file whole.
const BODY_SAMPLE_CHARS = 65536;

export async function frontmatterInferencePhase(
  engine: Engine,
): Promise<FrontmatterInferenceResult> {
  const result: FrontmatterInferenceResult = {
    scanned: 0,
    updated: 0,
    fields_added: { title: 0, tags: 0, created: 0, updated: 0 },
  };

  // Keyset-paginate by id so peak memory is O(FM_BATCH). The chunk-0 content is
  // a correlated subquery (LIMIT 1) so a doc with duplicate chunk_index=0 rows
  // can't multiply the result set, and LEFT() caps each sample.
  let afterId = "";
  for (;;) {
    const batch = await engine.query<DocRow>(
      `SELECT d.id,
              d.source_path,
              d.title,
              d.frontmatter,
              d.ingested_at::text AS ingested_at,
              d.updated_at::text  AS updated_at,
              COALESCE(
                (SELECT LEFT(c.content, ${BODY_SAMPLE_CHARS})
                   FROM chunks c
                  WHERE c.document_id = d.id AND c.chunk_index = 0
                  LIMIT 1),
                '') AS body_sample
       FROM documents d
       WHERE d.id > $1
       ORDER BY d.id
       LIMIT $2`,
      [afterId, FM_BATCH],
    );
    if (batch.rows.length === 0) break;

    for (const row of batch.rows) {
      result.scanned++;
      const fm = (row.frontmatter as Record<string, unknown> | null) ?? {};
      const newFm = { ...fm };
      let changed = false;

      if (!newFm["title"] && row.title) {
        newFm["title"] = row.title;
        result.fields_added.title++;
        changed = true;
      }
      if (!Array.isArray(newFm["tags"]) && typeof newFm["tags"] !== "string") {
        const tags = extractHashtags(row.body_sample).map((t) => t.name);
        if (tags.length > 0) {
          newFm["tags"] = Array.from(new Set(tags));
          result.fields_added.tags++;
          changed = true;
        }
      }
      if (!newFm["created"] && row.ingested_at) {
        newFm["created"] = row.ingested_at;
        result.fields_added.created++;
        changed = true;
      }
      if (!newFm["updated"] && row.updated_at) {
        newFm["updated"] = row.updated_at;
        result.fields_added.updated++;
        changed = true;
      }

      if (changed) {
        // `frontmatter` feeds the post-fusion salience multiplier, so inferring
        // it changes ranking — bump this doc's `generation` (Layer 2 of the
        // query cache, migration 031) so a cached row that returned this doc
        // invalidates. The global clock is bumped once at the end (Layer 1).
        await engine.query(
          `UPDATE documents SET frontmatter = $1::jsonb, generation = generation + 1 WHERE id = $2`,
          [JSON.stringify(wellFormJsonbValue(newFm)), row.id],
        );
        result.updated++;
      }
    }

    afterId = batch.rows[batch.rows.length - 1]!.id;
    if (batch.rows.length < FM_BATCH) break;
  }

  if (result.updated > 0) await bumpDocumentClock(engine);
  return result;
}
