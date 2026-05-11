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

export interface ExtractOptions {
  /**
   * If false (default), only re-extract chunks whose document hasn't been
   * touched since `cutoffMtimeMs`. If true, walk every chunk. The default
   * is conservative: changing the extractor is a deliberate act, the user
   * should pass --all explicitly.
   */
  all?: boolean;
  /**
   * When `all` is false, optional cutoff in ms-since-epoch. Defaults to
   * "epoch" (i.e. any document) — so the default for a no-flag run is
   * effectively "skip nothing", same as --all. will tighten this
   * once we have an extractor-version column on entities.
   */
  cutoffMtimeMs?: number;
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
  frontmatter: Record<string, unknown> | null;
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

  const docs = await db.query<DocRow>(
    `SELECT id, source_path, frontmatter
     FROM documents
     ORDER BY source_path
     ${opts.maxDocs ? "LIMIT $1" : ""}`,
    opts.maxDocs ? [opts.maxDocs] : [],
  );

  for (const doc of docs.rows) {
    try {
      const chunks = await db.query<ChunkRow>(
        "SELECT id, chunk_index, content FROM chunks WHERE document_id = $1 ORDER BY chunk_index",
        [doc.id],
      );
      if (chunks.rows.length === 0) continue;

      // Per-doc transaction — keeps the extract restartable mid-run.
      // Uses Engine.transaction so postgres-js / PGLite both work.
      await db.transaction(async (tx) => {
        for (const c of chunks.rows) {
          await tx.query(
            "DELETE FROM entity_mentions WHERE chunk_id = $1",
            [c.id],
          );
          const fm = c.chunk_index === 0 ? (doc.frontmatter ?? {}) : {};
          const ents = extractEntities(c.content, fm);
          await persistMentionsViaTx(tx, c.id, ents);
          result.chunks++;
        }
      });
      result.documents++;
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
