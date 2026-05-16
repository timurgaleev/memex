/**
 * Code indexer — turns a TypeScript / Python source file into rows in
 * `documents`, `chunks`, `entities`, `entity_mentions`. Graph-only:
 * no Titan calls, no rows in `embeddings`. (Q1 = `indexed_policy =
 * hashed-only`; flip later by computing vectors here and passing them
 * through to writeDocumentTransaction.)
 *
 * Idempotent at the file level — re-indexing the same source_path
 * replaces all of its chunks (cascade clears entity_mentions too).
 */
import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import type { Storage } from "./storage.ts";
import { chunkCode } from "./chunkers/code.ts";
import { languageForFile, type CodeLanguage } from "./chunkers/parsers.ts";
import { extractCodeEntities } from "./code-entities.ts";
import type { ExtractedEntity } from "./entities.ts";
import {
  writeDocumentTransaction,
  type ChunkWrite,
  type IndexTxResult,
} from "./indexer-tx.ts";

export interface IndexCodeResult extends IndexTxResult {
  /** True if tree-sitter reported syntax errors anywhere in the file. */
  hasParseError: boolean;
  /** Detected language; null for unsupported file types. */
  language: CodeLanguage | null;
  /** True if the file was skipped because the language is unsupported. */
  skipped: boolean;
}

export interface IndexCodeInput {
  sourcePath: string;
  text: string;
  mtimeMs?: number;
}

function shortHash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

function docId(sourcePath: string): string {
  return `doc_${shortHash(sourcePath)}`;
}

/**
 * Index a single in-memory source file. Returns counts plus a
 * `hasParseError` flag for the sweep to log on.
 */
export async function indexCodeDocument(
  storage: Storage,
  input: IndexCodeInput,
): Promise<IndexCodeResult> {
  if (!input.sourcePath || input.text === undefined) {
    throw new Error("indexCodeDocument: sourcePath and text are required");
  }
  const language = languageForFile(input.sourcePath);
  if (!language) {
    return {
      documentId: "",
      chunks: 0,
      embeddings: 0,
      entities: 0,
      hasParseError: false,
      language: null,
      skipped: true,
    };
  }

  const parsed = await chunkCode(input.text, input.sourcePath, language);
  const id = docId(input.sourcePath);

  // File-level imports become code-ref entities attached to chunk 0
  // (mirrors how the markdown indexer attaches frontmatter tags only
  // to chunk 0 — they're document-level signals, not symbol-level).
  const fileImportRefs: ExtractedEntity[] = parsed.fileImports.map((imp) => ({
    type: "code-ref",
    name: imp.name,
    surfaceForm: `${input.sourcePath}:${imp.line}:<import>`,
  }));

  // Build per-symbol entity sets. Each chunk corresponds to one symbol.
  const chunkWrites: ChunkWrite[] = [];
  for (let i = 0; i < parsed.symbols.length; i++) {
    const symbol = parsed.symbols[i]!;
    const entities = await extractCodeEntities({
      symbol,
      file: input.sourcePath,
      language,
    });
    // Prepend the file-level imports onto the FIRST symbol chunk so
    // `code-refs <name>` finds them.
    const merged = i === 0 ? [...fileImportRefs, ...entities] : entities;
    chunkWrites.push({
      text: symbol.body,
      startLine: symbol.startLine,
      endLine: symbol.endLine,
      embedding: null, // graph-only
      entities: merged,
    });
  }

  // Edge case: file has imports but no symbols. We still want the imports
  // searchable, so emit a synthetic chunk covering the import-only region.
  if (parsed.symbols.length === 0 && fileImportRefs.length > 0) {
    chunkWrites.push({
      text: input.text,
      startLine: 1,
      endLine: input.text.split(/\r?\n/).length,
      embedding: null,
      entities: fileImportRefs,
    });
  }

  const result = await writeDocumentTransaction(
    storage,
    {
      documentId: id,
      sourcePath: input.sourcePath,
      title: parsed.title,
      frontmatter: { language, kind: "code" },
      mtimeMs: input.mtimeMs ?? null,
      embeddingModel: null,
    },
    chunkWrites,
  );

  return {
    ...result,
    hasParseError: parsed.hasParseError,
    language,
    skipped: false,
  };
}

/**
 * Index a code file on disk. Reads the file, calls indexCodeDocument.
 */
// Same rationale as indexer.ts MAX_INDEX_FILE_BYTES — tree-sitter
// parsing is synchronous CPU and would block the Bun event loop on a
// monolithic minified bundle. 5 MiB matches the obsidian + indexer cap.
const MAX_INDEX_CODE_FILE_BYTES = 5 * 1024 * 1024;

export async function indexCodeFile(
  storage: Storage,
  filePath: string,
): Promise<IndexCodeResult> {
  let stat;
  try {
    stat = statSync(filePath);
  } catch {
    throw new Error(`indexCodeFile: file not found: ${filePath}`);
  }
  if (stat.size > MAX_INDEX_CODE_FILE_BYTES) {
    throw new Error(
      `indexCodeFile: ${filePath} is ${stat.size} bytes — exceeds ` +
        `${MAX_INDEX_CODE_FILE_BYTES} byte cap (likely a vendored bundle)`,
    );
  }
  const text = readFileSync(filePath, "utf8");
  return indexCodeDocument(storage, {
    sourcePath: filePath,
    text,
    mtimeMs: Math.floor(stat.mtimeMs),
  });
}
