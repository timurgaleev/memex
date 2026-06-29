/**
 * Re-extract entities from existing chunks WITHOUT re-embedding.
 *
 * Use cases:
 *   - the regex extractor changed (e.g. a new entity type was added)
 *   - manual repair after entity_mentions corruption
 *
 * Cheaper than the dream loop: no Bedrock calls. Walks chunks, runs the
 * pure regex pass, wipes the chunk's existing entity_mentions, inserts
 * fresh ones. Frontmatter tags attach to chunk 0 only — same convention
 * the indexer uses.
 */
import type { Storage } from "./storage.ts";
import {
  extractEntities,
  entityId,
  type ExtractedEntity,
} from "./entities.ts";

// Bump to the ship date whenever extractEntities()'s logic changes in a way that
// should re-run over the whole corpus — a doc whose entities_extracted_at predates
// this is treated as stale (migration 054). Mirrors links.ts's
// LINK_EXTRACTOR_VERSION_TS, the memex-native equivalent of the reference's
// incremental-extract change-set.
export const ENTITY_EXTRACTOR_VERSION_TS = "2026-06-29T00:00:00Z";

export interface ExtractOptions {
  /**
   * Force a FULL walk of every document. Default false → INCREMENTAL: only docs
   * stale per the migration-054 watermark (never extracted, extractor version
   * bumped, or re-indexed since last extract). The cycle runs incremental; the
   * CLI `extract --all` forces the full walk. Mirrors the reference's
   * "changed-slugs ⇒ incremental, absent ⇒ full walk".
   */
  all?: boolean;
  /**
   * Optional cap on documents processed in a single run. Defaults to no
   * cap. Useful when run interactively against a huge corpus.
   */
  maxDocs?: number;
}

export interface ExtractResult {
  documents: number;
  chunks: number;
  mentionsBefore: number;
  mentionsAfter: number;
  errors: { sourcePath: string; message: string }[];
}

interface DocRow {
  id: string;
  source_path: string;
  // ONLY the frontmatter `tags` value (the one field extractEntities reads), via
  // `frontmatter->'tags'` — NOT the whole JSONB. The live brain has docs with
  // 18–30 MB frontmatter (voicenote transcripts); selecting the full column for
  // the whole corpus on the first walk would reproduce the frontmatter-inference
  // OOM. Projecting just `tags` bounds the row to a few bytes.
  fm_tags: unknown;
  // Full-µs UTC string of updated_at (to_char, not ::text — DateStyle/2-digit-
  // offset fragile). Stamped back into entities_extracted_at so the staleness
  // predicate clears exactly; a concurrent re-index advancing updated_at keeps
  // the doc stale next run (D4 race fix, same as the link sweep).
  updated_at_iso: string;
}
interface ChunkRow {
  id: string;
  chunk_index: number;
  content: string;
}

export async function extractAll(
  storage: Storage,
  opts: ExtractOptions = {},
): Promise<ExtractResult> {
  const db = storage.raw();
  const result: ExtractResult = {
    documents: 0,
    chunks: 0,
    mentionsBefore: 0,
    mentionsAfter: 0,
    errors: [],
  };

  const before = await db.query<{ c: number }>(
    "SELECT COUNT(*)::int AS c FROM entity_mentions",
  );
  result.mentionsBefore = before.rows[0]?.c ?? 0;

  // Incremental by default (migration 054): only docs stale per the watermark.
  // $1=all-flag bypass (mirrors the reference's "no changed-slugs ⇒ full walk");
  // $2=the extractor-version arm. A full walk on the first run (all NULL).
  const params: unknown[] = [opts.all ?? false, ENTITY_EXTRACTOR_VERSION_TS];
  let limit = "";
  if (opts.maxDocs) {
    params.push(opts.maxDocs);
    limit = `LIMIT $${params.length}`;
  }
  const docs = await db.query<DocRow>(
    `SELECT id, source_path, frontmatter->'tags' AS fm_tags,
            to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at_iso
       FROM documents
      WHERE deleted_at IS NULL
        AND ($1::boolean
             OR entities_extracted_at IS NULL
             OR entities_extracted_at < $2::timestamptz
             OR updated_at > entities_extracted_at)
      ORDER BY source_path
      ${limit}`,
    params,
  );

  for (const doc of docs.rows) {
    try {
      const chunks = await db.query<ChunkRow>(
        "SELECT id, chunk_index, content FROM chunks WHERE document_id = $1 ORDER BY chunk_index",
        [doc.id],
      );

      if (chunks.rows.length > 0) {
        // Per-doc transaction — keeps the extract restartable mid-run.
        // Uses Engine.transaction so postgres-js / PGLite both work.
        await db.transaction(async (tx) => {
          for (const c of chunks.rows) {
            await tx.query(
              "DELETE FROM entity_mentions WHERE chunk_id = $1",
              [c.id],
            );
            // Only chunk 0 carries the doc-level frontmatter tags; extractEntities
            // reads `fm["tags"]`, so reconstruct just that field from fm_tags.
            const fm = c.chunk_index === 0 ? { tags: doc.fm_tags } : {};
            const ents = extractEntities(c.content, fm);
            await persistMentionsViaTx(tx, c.id, ents);
            result.chunks++;
          }
        });
        result.documents++;
      }

      // Stamp the watermark, even for a zero-chunk doc — else the incremental
      // query keeps re-selecting it. A doc that THREW above is left unstamped, so
      // it re-extracts next run. GREATEST(read updated_at, versionTs): the
      // updated_at arm gives the D4 race fix (a concurrent re-index advancing
      // updated_at re-stales the doc), and lifting to versionTs clears the
      // version-staleness arm so a doc edited BEFORE the current extractor
      // version doesn't re-extract forever (the link-sweep v1.38 fix).
      await db.query(
        `UPDATE documents
            SET entities_extracted_at = GREATEST($1::timestamptz, $3::timestamptz)
          WHERE id = $2`,
        [doc.updated_at_iso, doc.id, ENTITY_EXTRACTOR_VERSION_TS],
      );
    } catch (e) {
      result.errors.push({
        sourcePath: doc.source_path,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const after = await db.query<{ c: number }>(
    "SELECT COUNT(*)::int AS c FROM entity_mentions",
  );
  result.mentionsAfter = after.rows[0]?.c ?? 0;

  return result;
}

async function persistMentionsViaTx(
  tx: import("./engine/interface.ts").Engine,
  chunkId: string,
  entities: readonly ExtractedEntity[],
): Promise<void> {
  if (entities.length === 0) return;
  for (const e of entities) {
    const eid = entityId(e.type, e.name);
    await tx.query(
      `INSERT INTO entities (id, type, name)
       VALUES ($1, $2, $3)
       ON CONFLICT (id) DO NOTHING`,
      [eid, e.type, e.name],
    );
    await tx.query(
      `INSERT INTO entity_mentions (chunk_id, entity_id, surface_form)
       VALUES ($1, $2, $3)
       ON CONFLICT (chunk_id, entity_id) DO NOTHING`,
      [chunkId, eid, e.surfaceForm],
    );
  }
}
