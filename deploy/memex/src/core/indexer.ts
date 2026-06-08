/**
 * Indexer — turns a markdown document into rows in `documents`, `chunks`,
 * and `embeddings`. Idempotent at the document level: re-indexing the
 * same source_path replaces all of its chunks (and their embeddings via
 * ON DELETE CASCADE).
 *
 * Only ingests in-process strings + filesystem paths. Driven on demand by
 * the `memex reindex` CLI and the MCP `index` tool (no boot-time watcher).
 *
 * The atomic doc+chunks+entities writer lives in `core/indexer-tx.ts` so
 * the markdown indexer (this file, embeds via Titan) and the code
 * indexer (`core/indexer-code.ts`, graph-only) share one txn shape.
 */
import { lstatSync, readFileSync, statSync } from "node:fs";
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
// Cap any single document at 5 MiB before reading. A hostile or
// runaway markdown file (concatenated logs, accidental binary commit)
// would otherwise OOM the daemon and block the Bun event loop while
// readFileSync runs synchronously.
const MAX_INDEX_FILE_BYTES = 5 * 1024 * 1024;

export async function indexFile(
  storage: Storage,
  filePath: string,
  opts: IndexFileOptions = {},
): Promise<IndexResult> {
  // lstat to detect symlinks BEFORE the size check — a symlink to
  // /dev/zero would stat as 0 bytes and then hang readFileSync.
  let lstat;
  try {
    lstat = lstatSync(filePath);
  } catch {
    throw new Error(`indexFile: file not found: ${filePath}`);
  }
  if (lstat.isSymbolicLink()) {
    throw new Error(
      `indexFile: ${filePath} is a symlink — refusing to follow ` +
        `(use the canonical path)`,
    );
  }
  if (!lstat.isFile()) {
    throw new Error(`indexFile: ${filePath} is not a regular file`);
  }
  if (lstat.size > MAX_INDEX_FILE_BYTES) {
    throw new Error(
      `indexFile: ${filePath} is ${lstat.size} bytes — exceeds ` +
        `${MAX_INDEX_FILE_BYTES} byte cap (skip via vault config)`,
    );
  }
  // Re-stat via the regular statSync purely so the IndexResult timestamp
  // matches what the rest of the codebase computes elsewhere.
  const stat = statSync(filePath);
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
