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
import { embeddingSignature } from "./embedding.ts";
import { withRetry, BULK_RETRY_OPTS } from "./retry.ts";
import { wellFormJsonbObject } from "./well-form.ts";
import {
  importFilename,
  resolveEffectiveDateWithSource,
} from "./effective-date.ts";

export interface ChunkWrite {
  /** Chunk body text (will land in chunks.content). */
  text: string;
  /** Optional 1-based start line — populated for code chunks, NULL for markdown. */
  startLine?: number | null;
  /** Optional 1-based end line — populated for code chunks, NULL for markdown. */
  endLine?: number | null;
  /** Optional embedding vector for this chunk (omit for graph-only sources). */
  embedding?: number[] | null;
  /** Bare symbol identifier — populated for code chunks, NULL for markdown. */
  symbolName?: string | null;
  /** Qualified symbol name (parent path :: name) — code chunks only. The key
   *  the resolve-symbol-edges phase matches call targets against. */
  symbolNameQualified?: string | null;
  /** Symbol kind (function/class/method/arrow/const/module-import) — code only. */
  symbolType?: string | null;
  /**
   * Enclosing scope chain, outermost-first (empty/NULL at top level) — code
   * only. Persisted to `chunks.parent_symbol_path` (TEXT[]); an empty chain
   * stores NULL.
   */
  parentSymbolPath?: readonly string[] | null;
  /**
   * Extracted doc comment (JSDoc / `//` block / Python docstring) — code only,
   * NULL for markdown and for symbols with none. Persisted to
   * `chunks.doc_comment` and weighted 'A' in the chunk FTS (migration 032).
   */
  docComment?: string | null;
  /** Source language (typescript/python/…) — code only, NULL for markdown. */
  language?: string | null;
  /**
   * How this chunk was derived (migration 093). `'fenced_code'` for a code
   * example lifted out of a markdown page; NULL for ordinary prose + whole-file
   * code chunks. Persisted to `chunks.chunk_source`.
   */
  chunkSource?: string | null;
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
  /**
   * Chunker version that produced these chunks (migration 052) —
   * MARKDOWN_CHUNKER_VERSION for markdown, CODE_CHUNKER_VERSION for code.
   * Stamped onto `documents.chunker_version`; omitted → the column DEFAULT 1
   * (the grandfather value) applies on insert and is preserved on reindex.
   */
  chunkerVersion?: number;
  /**
   * Owning source (tenant). Stamped onto `documents.source_id` so search arms
   * scope results per tenant. Null/undefined → 'default' on a fresh insert and
   * leaves an existing row's source untouched on reindex (never clobbers a real
   * tenant with the fallback).
   */
  sourceId?: string | null;
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
  // Content date + its mig080 provenance, derived once outside the tx.
  const effectiveDate = resolveEffectiveDateWithSource(
    doc.frontmatter,
    doc.sourcePath,
  );

  // Wrap the whole transaction (not individual queries) in a connection-retry:
  // a dropped socket kills the tx, so retry must restart from BEGIN on a fresh
  // connection. The body is idempotent (documents upsert → DELETE chunks →
  // re-insert), so a replay reproduces the same end state — but the counters
  // must reset per attempt so a retried tx doesn't double-count.
  await withRetry(() => engine.transaction(async (tx) => {
    embeddingsWritten = 0;
    entitiesWritten = 0;
    await tx.query(
      `INSERT INTO documents (id, source_id, source_path, title, frontmatter, last_indexed_mtime, chunker_version, effective_date, effective_date_source, import_filename, updated_at)
       VALUES ($1, $6, $2, $3, $4::text::jsonb, $5, COALESCE($7, 1), $8, $9, $10, NOW())
       ON CONFLICT (id) DO UPDATE SET
         -- Keep the existing source on reindex unless the caller passes one
         -- explicitly. A null write leaves classification to the path-prefix
         -- backfill in core/sources.ts (don't freeze a doc as 'default').
         source_id          = COALESCE($6, documents.source_id),
         source_path        = EXCLUDED.source_path,
         title              = EXCLUDED.title,
         frontmatter        = EXCLUDED.frontmatter,
         last_indexed_mtime = EXCLUDED.last_indexed_mtime,
         -- Content date re-parsed from the fresh frontmatter on every re-index;
         -- the mig080 provenance pair moves with it.
         effective_date     = EXCLUDED.effective_date,
         effective_date_source = EXCLUDED.effective_date_source,
         import_filename    = EXCLUDED.import_filename,
         -- Re-index re-chunks under the CURRENT chunker, so advance the stamp;
         -- a metadata-only re-put that omits the version preserves the prior one.
         chunker_version    = COALESCE($7, documents.chunker_version),
         -- Per-document generation (migration 031) — Layer 2 of the query
         -- cache. A re-index bumps ONLY this document's counter, so the cache
         -- invalidates queries that reference this doc without touching
         -- unrelated cached queries. A fresh INSERT keeps the DEFAULT 0.
         generation         = documents.generation + 1,
         updated_at         = NOW()`,
      [
        doc.documentId,
        doc.sourcePath,
        doc.title,
        // Sanitize lone UTF-16 surrogates + NUL before the ::jsonb cast — a
        // single bad value (truncated emoji, mis-encoded source) would
        // otherwise make Postgres reject the cast and abort the whole index tx.
        // wellFormJsonbObject ALSO guards the object invariant: a non-object
        // frontmatter (a recipe passing raw content) collapses to {} instead of
        // serializing as a multi-MB jsonb scalar (the 420MB-frontmatter bug).
        JSON.stringify(wellFormJsonbObject(doc.frontmatter)),
        doc.mtimeMs ?? null,
        doc.sourceId ?? null,
        doc.chunkerVersion ?? null,
        effectiveDate.iso,
        effectiveDate.source,
        importFilename(doc.sourcePath),
      ],
    );

    // Bump the live-model generation clock so the query cache knows the
    // corpus changed (migration 025).
    await bumpDocumentClock(tx);

    // Read the AUTHORITATIVE source back from the row we just upserted — NOT the
    // raw doc.sourceId. On reindex the upsert keeps the prior source via
    // COALESCE($6, documents.source_id), so the stored value is the only correct
    // one. Mirroring it onto chunks (migration 058) keeps chunks.source_id ==
    // documents.source_id, including NULL, so a bridged/unclassified doc's chunks
    // never freeze to 'default'.
    const effSource =
      (
        await tx.query<{ source_id: string | null }>(
          "SELECT source_id FROM documents WHERE id = $1",
          [doc.documentId],
        )
      ).rows[0]?.source_id ?? null;

    // Wipe prior chunks for this document. Cascades to embeddings + entity_mentions
    // via ON DELETE CASCADE on the FK, so reindexing is idempotent.
    await tx.query("DELETE FROM chunks WHERE document_id = $1", [doc.documentId]);

    for (let i = 0; i < chunks.length; i++) {
      const ch = chunks[i];
      if (!ch) continue;
      const cid = `${doc.documentId}_c${i}`;
      await tx.query(
        `INSERT INTO chunks
           (id, document_id, chunk_index, content, start_line, end_line,
            symbol_name, symbol_type, parent_symbol_path, doc_comment, language,
            symbol_name_qualified, source_id, chunk_source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::text[], $10, $11, $12, $13, $14)`,
        [
          cid,
          doc.documentId,
          i,
          ch.text,
          ch.startLine ?? null,
          ch.endLine ?? null,
          ch.symbolName ?? null,
          ch.symbolType ?? null,
          // Empty / absent chain → NULL (never `{}`), so the column is always
          // either NULL or a non-empty TEXT[]. Mirrors migration 028, which
          // preserves NULL and casts existing scalars to 1-element arrays.
          ch.parentSymbolPath && ch.parentSymbolPath.length > 0
            ? [...ch.parentSymbolPath]
            : null,
          ch.docComment ?? null,
          ch.language ?? null,
          ch.symbolNameQualified ?? null,
          // Mirror the parent doc's authoritative source (migration 058) — NULL
          // stays NULL so unclassified docs don't freeze to 'default'.
          effSource,
          ch.chunkSource ?? null,
        ],
      );

      if (ch.embedding) {
        const embModel = doc.embeddingModel ?? "unknown";
        await tx.query(
          `INSERT INTO embeddings (chunk_id, vector, model, embedding_signature)
           VALUES ($1, $2::vector, $3, $4)`,
          [
            cid,
            JSON.stringify(ch.embedding),
            embModel,
            embeddingSignature(embModel, ch.embedding.length),
          ],
        );
        embeddingsWritten++;
      }

      entitiesWritten += await persistEntitiesViaTx(tx, cid, ch.entities);
    }
  }), BULK_RETRY_OPTS);

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
