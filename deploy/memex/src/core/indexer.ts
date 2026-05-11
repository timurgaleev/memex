/**
 * Indexer — turns a markdown document into rows in `documents`, `chunks`,
 * and `embeddings`. Idempotent at the document level: re-indexing the
 * same source_path replaces all of its chunks (and their embeddings via
 * ON DELETE CASCADE).
 *
 * only ingests in-process strings + filesystem paths.
 * wires this into the Obsidian vault recipe (chokidar watcher + sweep).
 *
 * The atomic doc+chunks+entities writer lives in `core/indexer-tx.ts` so
 * the markdown indexer (this file, embeds via Titan) and the code
 * indexer (`core/indexer-code.ts`, graph-only) share one txn shape.
 */
import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { chunkMarkdown } from "./chunkers/index.ts";
import { embedText } from "./embedding.ts";
import { extractEntities } from "./entities.ts";
import type { Storage } from "./storage.ts";
import {
  writeDocumentTransaction,
  type ChunkWrite,
  type IndexTxResult,
} from "./indexer-tx.ts";

export type IndexResult = IndexTxResult;

export interface IndexFileOptions {
  /** Override the source_path stored in the row (defaults to absolute path). */
  sourcePath?: string;
  /** Override the chunker config. */
  chunker?: { maxChars?: number; minChars?: number };
  /** Override embedding model id (e.g. for tests). */
  embeddingModel?: string;
}

const EMBED_MODEL = "amazon.titan-embed-text-v2:0";

function shortHash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

function docId(sourcePath: string): string {
  return `doc_${shortHash(sourcePath)}`;
}

export interface IndexInput {
  /** Where the document came from — used as the natural key. */
  sourcePath: string;
  /** Markdown source. */
  text: string;
  /** Optional file mtime in ms — recorded so the sweep can skip unchanged files. */
  mtimeMs?: number;
}

/**
 * Index a single in-memory markdown string.
 *
 * Embeds BEFORE the txn so a Bedrock failure doesn't half-write. Re-indexing
 * the same sourcePath replaces all prior chunks (cascade also wipes their
 * embeddings + entity_mentions).
 */
export async function indexDocument(
  storage: Storage,
  input: IndexInput,
  opts: IndexFileOptions = {},
): Promise<IndexResult> {
  if (!input.sourcePath || !input.text) {
    throw new Error("indexDocument: sourcePath and text are required");
  }

  const parsed = chunkMarkdown(input.text, opts.chunker);
  const id = docId(input.sourcePath);
  const model = opts.embeddingModel ?? EMBED_MODEL;

  // Embed BEFORE we touch the DB — if Bedrock fails, we don't half-write.
  const vectors: number[][] = [];
  for (const chunk of parsed.chunks) {
    vectors.push(await embedText(chunk, { modelId: model }));
  }

  const chunkWrites: ChunkWrite[] = parsed.chunks.map((text, i) => {
    // Frontmatter tags only attach to chunk 0 — they're document-level signals,
    // not chunk-level. Body wikilinks/hashtags/dates attach to the chunk they
    // appear in.
    const fm = i === 0 ? parsed.frontmatter : {};
    return {
      text,
      embedding: vectors[i] ?? null,
      entities: extractEntities(text, fm),
    };
  });

  return writeDocumentTransaction(
    storage,
    {
      documentId: id,
      sourcePath: input.sourcePath,
      title: parsed.title,
      frontmatter: parsed.frontmatter,
      mtimeMs: input.mtimeMs ?? null,
      embeddingModel: model,
    },
    chunkWrites,
  );
}

/**
 * Index a file on disk. Reads the file, calls indexDocument with absolute
 * path as sourcePath (or the override).
 */
export async function indexFile(
  storage: Storage,
  filePath: string,
  opts: IndexFileOptions = {},
): Promise<IndexResult> {
  // Surface a clearer error than fs.readFileSync's generic ENOENT.
  let stat;
  try {
    stat = statSync(filePath);
  } catch {
    throw new Error(`indexFile: file not found: ${filePath}`);
  }
  const text = readFileSync(filePath, "utf8");
  return indexDocument(
    storage,
    {
      sourcePath: opts.sourcePath ?? filePath,
      text,
      mtimeMs: Math.floor(stat.mtimeMs),
    },
    opts,
  );
}
