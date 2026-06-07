/**
 * Shared transactional writer for documents + chunks + entity_mentions.
 *
 * Used by both the markdown indexer (`core/indexer.ts`) and the code
 * indexer (`core/indexer-code.ts`). The two callers differ in two ways:
 *
 *   1. Markdown ships per-chunk Titan vectors → embeddings rows.
 *      Code is graph-only (Q1 = hashed-only) → no embeddings.
 *   2. Code chunks have line ranges (start_line, end_line) populated by
 *      tree-sitter; markdown chunks leave them NULL.
 *
 * The contract: caller pre-computes everything (chunks, entities, optional
 * vectors, optional line ranges); this function just writes it atomically.
 * Re-running with the same documentId wipes prior chunks (cascades to
 * embeddings + entity_mentions).
 */
import {
  entityId,
  type ExtractedEntity,
} from "./entities.ts";
import type { Engine } from "./engine/interface.ts";
import type { Storage } from "./storage.ts";
import { bumpDocumentClock } from "./generation.ts";

export interface ChunkWrite {
  /** Chunk body text (will land in chunks.content). */
  text: string;
  /** Optional 1-based start line — populated for code chunks, NULL for markdown. */
  startLine?: number | null;
  /** Optional 1-based end line — populated for code chunks, NULL for markdown. */
  endLine?: number | null;
  /** Optional embedding vector for this chunk (omit for graph-only sources). */
  embedding?: number[] | null;
  /** Entities to attach to this chunk's row in entity_mentions. */
  entities: readonly ExtractedEntity[];
}

export interface DocumentWrite {
  /** Stable id (caller's choice; usually `doc_<sha8>`). */
  documentId: string;
  /** Natural key — file path or external URI. */
  sourcePath: string;
  /** Document title (markdown's H1, or code file path). */
  title: string | null;
  /** Frontmatter / arbitrary doc-level metadata (JSONB). */
  frontmatter: Record<string, unknown>;
  /** mtime in ms — recorded so `sweepVault` / `sweepCodeRoots` can skip unchanged files. */
  mtimeMs?: number | null;
  /** Embedding model id (only meaningful when chunks carry vectors). */
  embeddingModel?: string | null;
}

export interface IndexTxResult {
  documentId: string;
  chunks: number;
  embeddings: number;
  entities: number;
}

/**
 * Atomically write a document + its chunks + per-chunk entity mentions
 * (and embeddings if any chunk carries one). Returns counts for the caller
 * to surface in CLI output / job-handler logs.
 */
export async function writeDocumentTransaction(
  storage: Storage,
  doc: DocumentWrite,
  chunks: readonly ChunkWrite[],
): Promise<IndexTxResult> {
  if (!doc.documentId || !doc.sourcePath) {
    throw new Error(
      "writeDocumentTransaction: documentId and sourcePath are required",
    );
  }

  const engine = storage.raw();
  let embeddingsWritten = 0;
  let entitiesWritten = 0;

  await engine.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO documents (id, source_path, title, frontmatter, last_indexed_mtime, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, NOW())
       ON CONFLICT (id) DO UPDATE SET
         source_path        = EXCLUDED.source_path,
         title              = EXCLUDED.title,
         frontmatter        = EXCLUDED.frontmatter,
         last_indexed_mtime = EXCLUDED.last_indexed_mtime,
         updated_at         = NOW()`,
      [
        doc.documentId,
        doc.sourcePath,
        doc.title,
        JSON.stringify(doc.frontmatter),
        doc.mtimeMs ?? null,
      ],
    );

    // Bump the live-model generation clock so the query cache knows the
    // corpus changed (migration 025).
    await bumpDocumentClock(tx);

    // Wipe prior chunks for this document. Cascades to embeddings + entity_mentions
    // via ON DELETE CASCADE on the FK, so reindexing is idempotent.
    await tx.query("DELETE FROM chunks WHERE document_id = $1", [doc.documentId]);

    for (let i = 0; i < chunks.length; i++) {
      const ch = chunks[i];
      if (!ch) continue;
      const cid = `${doc.documentId}_c${i}`;
      await tx.query(
        `INSERT INTO chunks (id, document_id, chunk_index, content, start_line, end_line)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [cid, doc.documentId, i, ch.text, ch.startLine ?? null, ch.endLine ?? null],
      );

      if (ch.embedding) {
        await tx.query(
          `INSERT INTO embeddings (chunk_id, vector, model)
           VALUES ($1, $2::vector, $3)`,
          [cid, JSON.stringify(ch.embedding), doc.embeddingModel ?? "unknown"],
        );
        embeddingsWritten++;
      }

      entitiesWritten += await persistEntitiesViaTx(tx, cid, ch.entities);
    }
  });

  return {
    documentId: doc.documentId,
    chunks: chunks.length,
    embeddings: embeddingsWritten,
    entities: entitiesWritten,
  };
}

async function persistEntitiesViaTx(
  tx: Engine,
  chunkId: string,
  entities: readonly ExtractedEntity[],
): Promise<number> {
  if (entities.length === 0) return 0;
  let count = 0;
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
    count++;
  }
  return count;
}
