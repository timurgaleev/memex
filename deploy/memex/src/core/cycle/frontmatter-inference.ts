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

export async function frontmatterInferencePhase(
  engine: Engine,
): Promise<FrontmatterInferenceResult> {
  // Pull docs with their first chunk (chunk_index=0) — that's where the
  // title-bearing prose usually lives. Hashtags can be anywhere; we cap
  // at chunk 0 to avoid full-table scans.
  const rows = await engine.query<DocRow>(
    `SELECT d.id,
            d.source_path,
            d.title,
            d.frontmatter,
            d.ingested_at::text AS ingested_at,
            d.updated_at::text  AS updated_at,
            COALESCE(c.content, '') AS body_sample
     FROM documents d
     LEFT JOIN chunks c
       ON c.document_id = d.id AND c.chunk_index = 0`,
  );

  const result: FrontmatterInferenceResult = {
    scanned: rows.rows.length,
    updated: 0,
    fields_added: { title: 0, tags: 0, created: 0, updated: 0 },
  };

  for (const row of rows.rows) {
    const fm = (row.frontmatter as Record<string, unknown> | null) ?? {};
    const newFm = { ...fm };
    let changed = false;

    if (!newFm["title"] && row.title) {
      newFm["title"] = row.title;
      result.fields_added.title++;
      changed = true;
    }
    if (
      !Array.isArray(newFm["tags"]) &&
      typeof newFm["tags"] !== "string"
    ) {
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
      // invalidates. The global clock is bumped once after the loop (Layer 1).
      await engine.query(
        `UPDATE documents SET frontmatter = $1::jsonb, generation = generation + 1 WHERE id = $2`,
        [JSON.stringify(wellFormJsonbValue(newFm)), row.id],
      );
      result.updated++;
    }
  }

  if (result.updated > 0) await bumpDocumentClock(engine);
  return result;
}
