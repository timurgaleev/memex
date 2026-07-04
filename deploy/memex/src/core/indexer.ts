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
import { MARKDOWN_CHUNKER_VERSION } from "./chunkers/recursive.ts";
import { stripFactsFence } from "./facts-fence.ts";
import { embedText, EMBED_DIMENSIONS } from "./embedding.ts";
import { isEmbedSkipped } from "./embed-skip.ts";
import {
  assessContentSanity,
  stampSanityMarkers,
  sanityGateEnabled,
  sanityDisposition,
  resolveSanityThresholds,
  resolveOperatorLiterals,
  ContentSanityBlockError,
} from "./content-sanity.ts";
import {
  contextualRetrievalEnabled,
  buildContextualPrefix,
  wrapChunkForEmbedding,
  extractFirstTwoSentences,
} from "./search/contextual-embed.ts";
import {
  contextualLlmEnabled,
  generateChunkContext,
  defaultContextualLlmBudget,
  CONTEXTUAL_LLM_LABEL,
} from "./search/contextual-llm.ts";
import { BudgetTracker } from "./budget.ts";
import type { LlmFn } from "./llm/haiku.ts";
import { extractEntities } from "./entities.ts";
import { bumpDocumentClock } from "./generation.ts";
import type { Storage } from "./storage.ts";
import {
  writeDocumentTransaction,
  type ChunkWrite,
  type IndexTxResult,
} from "./indexer-tx.ts";

export type IndexResult = IndexTxResult;

/** Embed one chunk into a vector. Injectable so tests embed offline. */
export type EmbedFn = (
  text: string,
  opts: { modelId: string },
) => Promise<number[]>;

export interface IndexFileOptions {
  /** Override the source_path stored in the row (defaults to absolute path). */
  sourcePath?: string;
  /** Override the chunker config. */
  chunker?: { maxChars?: number; minChars?: number };
  /** Override embedding model id (e.g. for tests). */
  embeddingModel?: string;
  /**
   * Override the embedder. Defaults to the real Titan `embedText`; tests
   * inject a deterministic embedder to stay offline (same seam pattern as
   * hybrid search's `embedQuery`).
   */
  embedFn?: EmbedFn;
  /**
   * Paid per-chunk LLM-context tier seam (`contextual-llm.ts`). Injected in
   * tests to exercise the LLM path with a fake — bypasses the env gate and any
   * Bedrock spend. Production leaves this unset; the `MEMEX_CONTEXTUAL_LLM` flag
   * drives whether the live utility model runs.
   */
  contextualLlmFn?: LlmFn;
  /**
   * Infer a frontmatter header at ingest for content that lacks one (the
   * reference's import-time inference). Default ON. The inferred block is NOT
   * persisted to disk or the body, so re-index MUST re-infer (it is pure +
   * deterministic — the same header every time) — do NOT pass `false` on a
   * reindex, or a headerless doc re-chunks bare and silently loses its inferred
   * type/date/tags. Pass `false` only for a caller whose `text` is NOT a raw
   * markdown file needing path-based inference (e.g. a page-body mirror).
   */
  inferFrontmatter?: boolean;
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
  /**
   * Extra document-level metadata merged OVER the body's parsed frontmatter
   * (these keys win). Used by the page bridge to stamp `page_content_hash`
   * so the cycle can detect a stale mirror.
   */
  extraFrontmatter?: Record<string, unknown>;
  /** Owning source (tenant) stamped onto the document. Defaults to 'default'. */
  sourceId?: string | null;
}

/**
 * Index a single in-memory markdown string.
 *
 * Embeds BEFORE the txn so a Bedrock failure doesn't half-write. Re-indexing
 * the same sourcePath replaces all prior chunks (cascade also wipes their
 * embeddings + entity_mentions).
 */
// Cap any single document at 5 MiB. The reference enforces this at BOTH ingest
// entry points — the file path AND the in-memory content path (its
// `importFromContent` guard, added specifically because the remote MCP write
// passes caller-supplied content straight in and bypasses the file-size check).
// memex had only the file-path cap (`indexFile` below); this is the missing
// content-path half — without it the remote `index` tool, page mirror, and
// embed-stale could store an unbounded document (the live brain accumulated
// 18–30 MB-frontmatter voicenote/gcal docs this way → cycle OOM).
const MAX_INDEX_FILE_BYTES = 5 * 1024 * 1024;

export async function indexDocument(
  storage: Storage,
  input: IndexInput,
  opts: IndexFileOptions = {},
): Promise<IndexResult> {
  if (!input.sourcePath || !input.text) {
    throw new Error("indexDocument: sourcePath and text are required");
  }
  const byteLength = Buffer.byteLength(input.text, "utf-8");
  if (byteLength > MAX_INDEX_FILE_BYTES) {
    throw new Error(
      `indexDocument: ${input.sourcePath} is ${byteLength} bytes — exceeds the ` +
        `${MAX_INDEX_FILE_BYTES} byte cap. Split it, or remove large embedded ` +
        `assets (e.g. an inline transcript stored in the frontmatter header).`,
    );
  }

  // Infer a frontmatter header at ingest for content that has none (the
  // reference's import-time inference — a per-file pure step, NOT a recurring
  // cycle phase). A doc that already starts with `---` is returned untouched.
  let text = input.text;
  if (opts.inferFrontmatter !== false) {
    const { applyInference } = await import("./frontmatter-inference.ts");
    const { content: inferred, inferred: meta } = applyInference(input.sourcePath, text);
    if (!meta.skipped) text = inferred;
  }

  // Strip the `## Facts` fence before chunking: the fence is a structured
  // metadata table projected into entity_facts (facts-reconcile), not prose —
  // indexing it as chunk text would duplicate it as noisy search content.
  // Frontmatter sits above the fence, so stripping it leaves parsing intact.
  const parsed = chunkMarkdown(stripFactsFence(text), opts.chunker);
  const id = docId(input.sourcePath);
  const model = opts.embeddingModel ?? EMBED_MODEL;
  const embed = opts.embedFn ?? embedText;

  const baseFrontmatter = input.extraFrontmatter
    ? { ...parsed.frontmatter, ...input.extraFrontmatter }
    : parsed.frontmatter;

  // Content-sanity gate (deterministic, free): stamp quarantine / content_flag
  // / embed_skip markers BEFORE embedding so scraper junk, oversize dumps, and
  // markup-heavy boilerplate can't enter the vector index. Junk is HIDDEN
  // (quarantine + embed_skip) by default; `MEMEX_SANITY_DISPOSITION=reject`
  // turns it into an explicit hard-block error. Oversize soft-blocks (embed_skip
  // + content_flag); markup-heavy flags. Kill switch: `MEMEX_NO_SANITY=1`.
  let frontmatter = baseFrontmatter;
  if (sanityGateEnabled()) {
    const sanity = assessContentSanity({
      body: parsed.chunks.join("\n\n"),
      title:
        parsed.title ??
        (typeof baseFrontmatter["title"] === "string"
          ? (baseFrontmatter["title"] as string)
          : ""),
      page_kind: baseFrontmatter["kind"] === "code" ? "code" : undefined,
      extra_literals: resolveOperatorLiterals(),
      ...resolveSanityThresholds(),
    });
    if (sanity.shouldQuarantine && sanityDisposition() === "reject") {
      throw new ContentSanityBlockError(sanity);
    }
    frontmatter = stampSanityMarkers(baseFrontmatter, sanity);
  }

  // Embed BEFORE we touch the DB — if Bedrock fails, we don't half-write. A page
  // marked `embed_skip` is indexed + keyword-searchable but never embedded: its
  // chunks land with a null vector so the vector arm skips them.
  const skipEmbed = isEmbedSkipped(frontmatter);
  // Contextual-retrieval wrapper (opt-in, default-OFF): prepend a document-level
  // <context>{title}\n{synopsis}</context> header to each chunk's EMBEDDING INPUT
  // only — the canonical chunk text written below is untouched. Code docs bypass
  // wrapping. The deterministic synopsis = the first two sentences of the page's
  // opening chunk. The PAID per-chunk LLM tier (MEMEX_CONTEXTUAL_LLM) instead
  // asks a utility model to situate EACH chunk within the whole document; a null
  // result (budget/err) falls back to the deterministic prefix (fail-open).
  const isCode = frontmatter["kind"] === "code";
  const ctxTitle =
    parsed.title ??
    (typeof frontmatter["title"] === "string" ? (frontmatter["title"] as string) : null);
  // Either flag (or an injected llmFn) turns wrapping on; the LLM tier is a
  // superset that upgrades the synopsis, so it must build the deterministic
  // prefix too (its fallback path).
  const llmActive =
    (contextualLlmEnabled() || opts.contextualLlmFn !== undefined) && !isCode && !skipEmbed;
  const wrapActive =
    (contextualRetrievalEnabled() || llmActive) && !isCode;
  const deterministicPrefix = wrapActive
    ? buildContextualPrefix(ctxTitle, extractFirstTwoSentences(parsed.chunks[0] ?? ""), { isCode })
    : null;
  const docText = llmActive ? parsed.chunks.join("\n\n") : "";
  // Fresh budget per document at index time (a new doc is a small, bounded run);
  // the whole-corpus backfill is where a single shared budget matters.
  const ctxBudget = llmActive
    ? new BudgetTracker(defaultContextualLlmBudget(), CONTEXTUAL_LLM_LABEL)
    : undefined;
  // Unchanged-chunk embedding reuse: re-indexing a doc rewrites all its chunks
  // (indexer-tx deletes + reinserts), but a chunk whose RAW text is byte-identical
  // to the prior version at the same index — under the same embedding model —
  // hasn't changed meaning, so we reuse its stored vector instead of paying
  // Bedrock (and the paid contextual-LLM tier) again. Editing one line of a page
  // then only re-embeds the chunk(s) that actually moved. The equality key is the
  // canonical chunk text (chunks.content), matching what was stored; a global
  // contextual-mode flip still needs a full `reindex --contextual` (guarded here
  // by the model check — a mode change doesn't alter the model, so treat mode
  // changes as out of scope for incremental reuse).
  const prior = new Map<number, { content: string; vec: number[]; model: string }>();
  if (!skipEmbed) {
    try {
      const priorRows = await storage.engine().query<{
        chunk_index: number;
        content: string;
        vec: string | null;
        model: string | null;
      }>(
        `SELECT c.chunk_index, c.content, e.vector::text AS vec, e.model
           FROM chunks c LEFT JOIN embeddings e ON e.chunk_id = c.id
          WHERE c.document_id = $1`,
        [id],
      );
      for (const r of priorRows.rows) {
        if (r.vec === null || r.model === null) continue;
        prior.set(Number(r.chunk_index), {
          content: r.content,
          vec: JSON.parse(r.vec) as number[],
          model: r.model,
        });
      }
    } catch {
      // A read failure just means no reuse this pass — re-embed everything.
      prior.clear();
    }
  }

  const vectors: (number[] | null)[] = [];
  for (let i = 0; i < parsed.chunks.length; i++) {
    const chunk = parsed.chunks[i]!;
    if (!skipEmbed) {
      const reuse = prior.get(i);
      // Width is checked alongside model: MEMEX_EMBED_DIM can change the vector
      // dimension without changing the Titan model id, and mixing widths inside
      // one document breaks the `<=>` scan — so a stored vector of a different
      // dimension is never reused. Note: under contextual retrieval a reused
      // chunk keeps its prior document-level context (title/synopsis) even if an
      // earlier chunk or the title changed — an accepted precision tradeoff; a
      // full re-embed (`reindex --contextual`) refreshes it.
      if (
        reuse &&
        reuse.model === model &&
        reuse.vec.length === EMBED_DIMENSIONS &&
        reuse.content === chunk
      ) {
        vectors.push(reuse.vec);
        continue; // skip generateChunkContext + embed — the paid-call saving
      }
    }
    let prefix = deterministicPrefix;
    if (llmActive) {
      const llmCtx = await generateChunkContext(docText, chunk, {
        ...(opts.contextualLlmFn ? { llmFn: opts.contextualLlmFn } : {}),
        ...(ctxBudget ? { budget: ctxBudget } : {}),
      });
      if (llmCtx) prefix = buildContextualPrefix(ctxTitle, llmCtx, { isCode });
    }
    const embedInput = wrapChunkForEmbedding(chunk, prefix, { isCode });
    vectors.push(skipEmbed ? null : await embed(embedInput, { modelId: model }));
  }

  const chunkWrites: ChunkWrite[] = parsed.chunks.map((text, i) => {
    // Frontmatter tags only attach to chunk 0 — they're document-level signals,
    // not chunk-level. Body wikilinks/hashtags/dates attach to the chunk they
    // appear in.
    const fm = i === 0 ? frontmatter : {};
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
      // Title column: the H1, else the frontmatter `title` (an explicit header
      // or one synthesized by ingest inference) — mirrors the reference folding
      // a frontmatter title into the title column, so an inferred title for a
      // headerless, H1-less doc still reaches `documents.title`.
      title:
        parsed.title ??
        (typeof frontmatter["title"] === "string"
          ? (frontmatter["title"] as string)
          : null),
      frontmatter,
      mtimeMs: input.mtimeMs ?? null,
      embeddingModel: model,
      chunkerVersion: MARKDOWN_CHUNKER_VERSION,
      sourceId: input.sourceId ?? null,
    },
    chunkWrites,
  );
}

/**
 * Index a file on disk. Reads the file, calls indexDocument with absolute
 * path as sourcePath (or the override). The file-size cap (defense-in-depth
 * before readFileSync) shares MAX_INDEX_FILE_BYTES with indexDocument above.
 */
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

/**
 * Remove a document (and, via ON DELETE CASCADE, its chunks + embeddings +
 * entity_mentions) by its source_path. Idempotent — deleting an absent
 * document is a no-op. Returns whether a row was removed. Bumps the
 * generation clock so the query cache invalidates.
 */
export async function removeDocument(
  storage: Storage,
  sourcePath: string,
): Promise<{ removed: boolean }> {
  if (!sourcePath) throw new Error("removeDocument: sourcePath is required");
  const id = docId(sourcePath);
  const engine = storage.raw();
  let removed = false;
  await engine.transaction(async (tx) => {
    const r = await tx.query<{ id: string }>(
      "DELETE FROM documents WHERE id = $1 RETURNING id",
      [id],
    );
    removed = r.rows.length > 0;
    if (removed) await bumpDocumentClock(tx);
  });
  return { removed };
}
