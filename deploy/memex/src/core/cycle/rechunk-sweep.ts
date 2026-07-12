/**
 * rechunk-sweep — the automatic, cost-gated re-chunk + re-embed sweep that
 * drains chunker-version-stale documents a bounded batch at a time.
 *
 * memex already TRACKS chunker staleness (`documents.chunker_version` vs
 * MARKDOWN_CHUNKER_VERSION — see chunker-version.ts) and exposes a MANUAL
 * `reindex --rechunk-stale` that walks the whole vault. What it lacked is the
 * AUTOMATIC drain: when the markdown chunker constant bumps, every markdown doc is stale
 * and needs a re-chunk + re-embed, but doing that all at once is a surprise
 * Bedrock bill and a long wall-clock stall. This phase spreads the work across
 * ticks under a hard per-tick cap.
 *
 * DELIBERATELY OPT-IN + BOUNDED (it spends Bedrock Titan on every re-embed):
 *   - default-OFF behind `MEMEX_RECHUNK_SWEEP=1` (an injected `embedFn` bypasses
 *     the gate for hermetic tests, same seam as the other paid phases);
 *   - COUNT-capped per tick (`maxDocs`, env MEMEX_RECHUNK_SWEEP_MAX, default 25);
 *   - CHAR-BUDGET-capped per tick (`maxChars`, env MEMEX_RECHUNK_SWEEP_MAX_CHARS,
 *     default 1,000,000) as a spend proxy — always drains at least one doc, then
 *     stops before crossing the budget so a huge doc can never starve the tick.
 *
 * RESUMABLE across ticks WITHOUT any cursor: re-indexing a doc re-stamps its
 * `chunker_version` to the current markdown version (see indexer.ts), so it
 * leaves the stale set and the next tick's bounded query naturally advances to
 * the next batch. IDEMPOTENT: a doc already at the current version never matches
 * the staleness predicate, so a fresh doc is never re-done.
 *
 * MARKDOWN-ONLY. `indexDocument` is the
 * markdown ingest path (it stamps MARKDOWN_CHUNKER_VERSION and markdown-chunks
 * the body); running a `kind='code'` doc through it would mis-stamp and
 * mis-chunk it. Code docs re-chunk lazily on their own reindex. The predicate is
 * the markdown branch of chunker-version.ts's STALE_CHUNKER_WHERE.
 *
 * TENANCY: each row's own `source_id` is read back and passed to the re-index so
 * the sweep preserves the owning tenant rather than resetting it to default.
 */
import { existsSync, readFileSync } from "node:fs";
import type { Engine } from "../engine/interface.ts";
import type { EmbedFn } from "../indexer.ts";
import { Storage } from "../storage.ts";
import { indexDocument } from "../indexer.ts";
import { MARKDOWN_CHUNKER_VERSION } from "../chunkers/recursive.ts";

const DEFAULT_MAX_DOCS = 25;
const DEFAULT_MAX_CHARS = 1_000_000;

export interface RechunkSweepOptions {
  /** Hard cap on docs re-chunked per tick. Default MEMEX_RECHUNK_SWEEP_MAX or 25. */
  maxDocs?: number;
  /**
   * Cumulative source-char budget per tick (spend proxy). Default
   * MEMEX_RECHUNK_SWEEP_MAX_CHARS or 1,000,000. At least one doc always runs.
   */
  maxChars?: number;
  /**
   * Embedder seam. Injected in tests to stay offline; when set it ALSO bypasses
   * the MEMEX_RECHUNK_SWEEP env gate (same pattern as the paid synthesis phases'
   * injected LLM fns). Production leaves it unset → real Titan + the env gate.
   */
  embedFn?: EmbedFn;
  /** Embedding model id override (tests). */
  embeddingModel?: string;
}

export interface RechunkSweepResult {
  /** False when the phase was gated off (disabled + no injected embedder). */
  ran: boolean;
  reason?: string;
  /** Candidate stale docs fetched this tick (bounded by maxDocs). */
  scanned: number;
  /** Docs actually re-chunked + re-embedded this tick. */
  rechunked: number;
  /** Stale docs whose source file was gone from disk (skipped; orphans-purge collects). */
  skippedMissing: number;
  /** Cumulative source chars re-embedded this tick. */
  charsProcessed: number;
  /** True when the char budget stopped the tick before the count cap. */
  budgetExhausted: boolean;
  errors: { sourcePath: string; message: string }[];
}

interface StaleRow {
  id: string;
  source_path: string;
  source_id: string | null;
}

/**
 * The markdown-only, chunker-version-stale doc set, bounded to `limit` and
 * ordered deterministically so the tick-to-tick drain is stable.
 */
export async function findChunkerStaleDocs(
  engine: Engine,
  limit: number,
): Promise<StaleRow[]> {
  const r = await engine.query<StaleRow>(
    `SELECT d.id, d.source_path, d.source_id
       FROM documents d
      WHERE d.deleted_at IS NULL
        AND COALESCE(d.frontmatter->>'kind','') <> 'code'
        AND d.chunker_version < $1
      ORDER BY d.source_path
      LIMIT $2`,
    [MARKDOWN_CHUNKER_VERSION, limit],
  );
  return r.rows;
}

function resolveCap(opt: number | undefined, envName: string, fallback: number): number {
  if (typeof opt === "number" && opt > 0) return opt;
  const raw = (process.env[envName] ?? "").trim();
  if (raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export async function rechunkSweepPhase(
  engine: Engine,
  opts: RechunkSweepOptions = {},
): Promise<RechunkSweepResult> {
  const base: RechunkSweepResult = {
    ran: false,
    scanned: 0,
    rechunked: 0,
    skippedMissing: 0,
    charsProcessed: 0,
    budgetExhausted: false,
    errors: [],
  };

  // Gate: OFF unless MEMEX_RECHUNK_SWEEP=1 — but an injected embedder (tests)
  // bypasses the gate so the drain can be exercised without live Bedrock.
  if (!opts.embedFn && process.env.MEMEX_RECHUNK_SWEEP !== "1") {
    return { ...base, reason: "disabled (MEMEX_RECHUNK_SWEEP not set)" };
  }

  const maxDocs = resolveCap(opts.maxDocs, "MEMEX_RECHUNK_SWEEP_MAX", DEFAULT_MAX_DOCS);
  const maxChars = resolveCap(opts.maxChars, "MEMEX_RECHUNK_SWEEP_MAX_CHARS", DEFAULT_MAX_CHARS);

  const stale = await findChunkerStaleDocs(engine, maxDocs);
  const result: RechunkSweepResult = { ...base, ran: true, scanned: stale.length };

  const storage = new Storage(engine);
  const indexOpts: { embedFn?: EmbedFn; embeddingModel?: string } = {};
  if (opts.embedFn) indexOpts.embedFn = opts.embedFn;
  if (opts.embeddingModel) indexOpts.embeddingModel = opts.embeddingModel;

  for (const row of stale) {
    if (!existsSync(row.source_path)) {
      result.skippedMissing++;
      continue; // orphans-purge handles a doc whose file is gone
    }
    try {
      const text = readFileSync(row.source_path, "utf8");
      await indexDocument(
        storage,
        { sourcePath: row.source_path, text, sourceId: row.source_id },
        indexOpts,
      );
      result.rechunked++;
      result.charsProcessed += text.length;
      // Spend proxy: once this tick has crossed the char budget, stop and let
      // the next tick pick up the rest (the drain is resumable by construction).
      if (result.charsProcessed >= maxChars) {
        result.budgetExhausted = true;
        break;
      }
    } catch (e) {
      result.errors.push({
        sourcePath: row.source_path,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return result;
}
