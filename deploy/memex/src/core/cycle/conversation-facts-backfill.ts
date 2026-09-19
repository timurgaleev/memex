/**
 * conversation-facts-backfill — opt-in, default-OFF cycle phase that runs the
 * on-write fact extractor over prose pages that have never been extracted, so a
 * transcript imported outside the MCP write path (bulk import, sync) still gets
 * its facts unattended, mapped onto memex's per-page extractor.
 *
 * PAID (Bedrock Sonnet) and default-OFF on TWO independent guards:
 *   1. it is NOT in ALL_PHASES — a normal cycle never runs it; it runs only via
 *      `--phases conversation-facts-backfill`, and
 *   2. even when requested it no-ops unless MEMEX_FACTS_BACKFILL is truthy.
 * A brain-wide USD budget (MEMEX_FACTS_BACKFILL_BUDGET_USD, default $1) and a
 * per-run page cap bound the spend; the phase stops cleanly when either is hit.
 *
 * Idempotency: a page is "already backfilled" once it has ANY fact authored by
 * the on-write writer (`facts-extract`) keyed to its (slug, source_id), or a
 * `facts_backfill_scans` zero-yield row for its (source_id, slug, content_hash,
 * FACTS_EXTRACT_VERSION). The memo is written only when the paid call read
 * cleanly and yielded no new fact, so editing the page or bumping the extractor
 * version re-opens it, while malformed, truncated, budget and model-error
 * outcomes, and extracted facts that failed to write, are never memoized and
 * stay retryable.
 *
 * FALLS-OPEN: a per-page failure is collected in `errors[]`; the phase never
 * throws (the cycle marks it `warn` when errors[] is non-empty).
 */
import type { Storage } from "../storage.ts";
import {
  EXTRACTION_ELIGIBLE_TYPES,
  FACTS_EXTRACT_VERSION,
  ON_WRITE_WRITER,
  extractFactsForPage,
} from "../facts-extract.ts";
import { resolveFactsModel } from "../llm/sonnet.ts";
import type { SonnetFn } from "../llm/sonnet.ts";
import type { LlmFn } from "../llm/haiku.ts";
import { filterWorthwhile, worthGateEnabled } from "../synthesis/worth-gate.ts";

export interface ConversationFactsBackfillOptions {
  /** Cap on pages processed per run. Default 50. */
  maxPages?: number;
  /** Brain-wide USD ceiling for the run. Default from env / $1. */
  maxBudgetUsd?: number;
  /** Test seam — inject a fake model; also bypasses the MEMEX_FACTS_BACKFILL gate. */
  sonnetFn?: SonnetFn;
  modelId?: string;
  /**
   * Pre-screen each page with the cached Haiku worth gate before paying Sonnet
   * on it. Default from MEMEX_WORTH_GATE (OFF). The gate is fail-open — a judge
   * error keeps the page.
   */
  worthGate?: boolean;
  /** Haiku seam for the worth gate (tests). */
  worthLlmFn?: LlmFn;
}

export interface ConversationFactsBackfillResult {
  ran: boolean;
  reason?: string;
  pagesConsidered: number;
  pagesProcessed: number;
  factsWritten: number;
  /** Pages memoized as zero-yield this run (skipped by later runs until edited). */
  zeroYieldRecorded: number;
  /** Pages the worth gate screened out before any Sonnet spend. */
  worthSkipped: number;
  spentUsd: number;
  budgetExhausted: boolean;
  errors: { slug: string; message: string }[];
}

const DEFAULT_MAX_PAGES = 50;

export function backfillEnabled(
  env: string | undefined = process.env["MEMEX_FACTS_BACKFILL"],
): boolean {
  const v = (env ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
}

function defaultBudgetUsd(): number {
  const raw = (process.env["MEMEX_FACTS_BACKFILL_BUDGET_USD"] ?? "").trim();
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 1.0;
}

interface PageRow {
  slug: string;
  type: string;
  markdown_body: string;
  source_id: string;
  content_hash: string;
}

export async function conversationFactsBackfillPhase(
  storage: Storage,
  opts: ConversationFactsBackfillOptions = {},
): Promise<ConversationFactsBackfillResult> {
  const empty: ConversationFactsBackfillResult = {
    ran: false,
    pagesConsidered: 0,
    pagesProcessed: 0,
    factsWritten: 0,
    zeroYieldRecorded: 0,
    worthSkipped: 0,
    spentUsd: 0,
    budgetExhausted: false,
    errors: [],
  };

  // Default-OFF: a live (paid) run requires the explicit gate. Tests inject a
  // sonnetFn, which bypasses the gate and avoids any spend.
  if (!opts.sonnetFn && !backfillEnabled()) {
    return {
      ...empty,
      reason: "default-OFF: set MEMEX_FACTS_BACKFILL=1 to run paid backfill",
    };
  }

  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  const cap = opts.maxBudgetUsd ?? defaultBudgetUsd();

  const rows = await storage.engine().query<PageRow>(
    `SELECT p.slug, p.type, p.markdown_body, p.source_id, p.content_hash
       FROM pages p
      WHERE p.deleted_at IS NULL
        AND p.type = ANY($1::text[])
        AND length(btrim(p.markdown_body)) >= 80
        AND p.slug NOT LIKE 'wiki/agents/%'
        -- Synthesis-written pages are not transcripts; extracting facts from
        -- them would pay to re-derive our own output on every run.
        AND p.slug NOT LIKE 'reflections/%'
        AND p.slug NOT LIKE 'patterns/%'
        AND NOT EXISTS (
          -- Match on (source_slug, source_id): a same-slug page in ANOTHER
          -- source must not mask THIS page's un-extracted facts (pages are
          -- keyed by (slug, source_id), so slug alone over-skips cross-source).
          SELECT 1 FROM entity_facts f
           WHERE f.source_slug = p.slug
             AND f.source_id = p.source_id
             AND f.written_by = $2
        )
        -- Before LIMIT, so memoized zero-yield pages do not take this run's slots.
        AND NOT EXISTS (
          SELECT 1 FROM facts_backfill_scans s
           WHERE s.source_id = p.source_id
             AND s.slug = p.slug
             AND s.content_hash = p.content_hash
             AND s.extractor_version = $4
        )
      ORDER BY p.updated_at DESC
      LIMIT $3`,
    [[...EXTRACTION_ELIGIBLE_TYPES], ON_WRITE_WRITER, maxPages, FACTS_EXTRACT_VERSION],
  );

  const result: ConversationFactsBackfillResult = { ...empty, ran: true };
  let spent = 0;

  // Worth gate (opt-in): screen out low-signal pages with the cached Haiku
  // judge BEFORE any Sonnet spend. Fail-open — gate errors keep the page.
  let pages = rows.rows;
  if (opts.worthGate ?? worthGateEnabled()) {
    const gate = await filterWorthwhile(
      storage.engine(),
      pages.map((p) => ({ ref: p.slug, content: p.markdown_body })),
      opts.worthLlmFn ? { llmFn: opts.worthLlmFn } : {},
    );
    result.worthSkipped = gate.skipped;
    for (const e of gate.errors) {
      const idx = e.indexOf(": ");
      result.errors.push({
        slug: idx > 0 ? e.slice(0, idx) : "worth-gate",
        message: idx > 0 ? e.slice(idx + 2) : e,
      });
    }
    pages = pages.filter((p) => gate.kept.has(p.slug));
  }

  for (const page of pages) {
    result.pagesConsidered += 1;
    // Brain-wide budget stop: if the prior spend already reached the cap, stop
    // before dispatching another paid call.
    if (spent >= cap) {
      result.budgetExhausted = true;
      break;
    }
    try {
      const r = await extractFactsForPage(storage, {
        slug: page.slug,
        type: page.type,
        body: page.markdown_body,
        sourceId: page.source_id,
        ...(opts.sonnetFn ? { sonnetFn: opts.sonnetFn } : {}),
        ...(opts.modelId ? { modelId: opts.modelId } : {}),
        // Give each page the remaining brain-wide headroom as its per-call cap.
        maxBudgetUsd: Math.max(cap - spent, 0.000001),
      });
      spent += r.spentUsd;
      result.factsWritten += r.factsWritten;
      result.pagesProcessed += 1;
      // A page whose paid call came back unreadable writes no fact row, so the
      // "has a written_by row" marker above never fires and the next run pays
      // for it again. Surface it (the cycle marks the phase `warn`) instead of
      // letting that loop bill silently forever.
      if (r.absorbed === "parse_failure" || r.absorbed === "output_truncated") {
        result.errors.push({
          slug: page.slug,
          message: `extraction absorbed: ${r.absorbed}`,
        });
      }
      // Facts that failed to write were never persisted: the page is not
      // empty, so it must stay open for the next run rather than be memoized.
      if (r.factsFailed > 0) {
        result.errors.push({
          slug: page.slug,
          message: `${r.factsFailed} extracted fact(s) failed to write`,
        });
      }
      if (r.absorbed === null && r.factsWritten === 0 && r.factsFailed === 0) {
        await storage.engine().query(
          `INSERT INTO facts_backfill_scans
             (source_id, slug, content_hash, extractor_version, outcome, facts_skipped, model_id)
           VALUES ($1, $2, $3, $4, 'zero_yield', $5, $6)
           ON CONFLICT DO NOTHING`,
          [
            page.source_id,
            page.slug,
            page.content_hash,
            FACTS_EXTRACT_VERSION,
            r.factsSkipped,
            resolveFactsModel(opts.modelId),
          ],
        );
        result.zeroYieldRecorded += 1;
      }
    } catch (e) {
      result.errors.push({
        slug: page.slug,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  result.spentUsd = Number(spent.toFixed(6));
  return result;
}
