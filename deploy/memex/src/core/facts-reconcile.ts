/**
 * Facts-fence reconciliation — make the entity_facts DB index match a page's
 * `## Facts` fence (the system of record). LLM-FREE: the fence is canonical
 * structured markdown; this deterministically parses it and re-projects it
 * into the DB. (Faithful adaptation of the reference's extract_facts cycle
 * phase, minus its optional fact-text embedding — memex can add that later via
 * its existing Bedrock path; the reconcile itself never needs a model.)
 *
 * Per page write, `reconcileFactsForPage`:
 *   1. RE-READS the page's CURRENT body + content_hash, and skips if the page
 *      moved on since the triggering write (a newer write's own reconcile will
 *      project the newer body) — this is the concurrency guard,
 *   2. parses the `## Facts` fence (core/facts-fence.ts),
 *   3. WIPES that page's fence-owned fact rows
 *      (`DELETE … WHERE source_markdown_slug = <page>`),
 *   4. re-inserts the ACTIVE (non-struck) fence rows, keyed by
 *      `source_markdown_slug` + `row_num` (migration 035).
 *
 * It runs on EVERY page write (not just content changes) so an idempotent
 * re-put is a REPAIR path: if a prior reconcile failed, re-putting the page
 * rebuilds the index. The wipe is scoped to `source_markdown_slug = <page>`,
 * so a legacy or explicitly-asserted fact (NULL source_markdown_slug, e.g. via
 * `add_fact`) is INVISIBLE to it and survives — the column scoping is the
 * empty-fence guard.
 *
 * A page whose fence is genuinely ABSENT (no fence markers) wipes its own
 * fence rows (operator removed the fence). But a fence whose markers are
 * PRESENT yet parse to zero rows (a hand-edit syntax typo, or an emptied
 * table) does NOT wipe — a malformed fence must never silently destroy the
 * prior projection.
 *
 * Each fence fact is keyed `entity_slug = <the page hosting the fence>` — the
 * fence states facts ABOUT that page's subject. `entity_slug` has no FK, so a
 * fence on a non-entity page is harmless. A page's markdown body is NOT
 * chunk-indexed (pages are the DB-canonical store; the search chunk index
 * comes from `indexDocument`, which strips the fence first), so the fence is
 * never double-represented as searchable prose.
 */
import type { Storage } from "./storage.ts";
import type { Engine } from "./engine/interface.ts";
import { validateSlug, getPage } from "./pages.ts";
import { parseFactsFence, FACTS_FENCE_BEGIN } from "./facts-fence.ts";

/** Marks a fence-derived fact row's author (parallels the gazetteer's link_kind). */
const FENCE_WRITER = "memex:facts-fence";
/** PostgreSQL INTEGER upper bound — a hand-edited row_num above this would
 *  overflow the column and abort every reconcile, so it is clamped. */
const MAX_ROW_NUM = 2_147_483_647;
/** Hard cap on fence rows projected per page (defence vs a pathological fence
 *  producing an unbounded INSERT loop / long transaction). */
const MAX_FACTS_FENCE_ROWS = 1000;

/**
 * Fence reconciliation is on by default — it only ever touches rows a page's
 * OWN fence produced, so it is safe. `MEMEX_FACTS_FENCE=0` disables it (a kill
 * switch; the fence then stays inert as it was before this feature).
 */
export function factsFenceEnabled(
  env: string | undefined = process.env.MEMEX_FACTS_FENCE,
): boolean {
  return env !== "0";
}

/** Validate a hand-edited provenance slug; return null if it isn't a valid slug
 *  (the fence is hand-editable and must degrade gracefully, never throw). */
function safeSourceSlug(raw: string | undefined): string | null {
  if (raw === undefined || raw.length === 0) return null;
  try {
    validateSlug(raw);
    return raw;
  } catch {
    return null;
  }
}

/**
 * Reconcile `pageSlug`'s fence-owned facts to its CURRENT body's `## Facts`
 * fence. `expectedContentHash` is the content hash of the write that triggered
 * this call: if the page's persisted hash no longer matches, a newer write
 * landed and owns the reconcile — this call skips (no stale projection).
 * Returns counts removed/added; `{0,0}` when disabled, skipped, or a malformed
 * fence is left untouched. Runs the wipe+insert in one transaction.
 */
export async function reconcileFactsForPage(
  storage: Storage,
  pageSlug: string,
  expectedContentHash: string,
): Promise<{ removed: number; added: number }> {
  if (!factsFenceEnabled()) return { removed: 0, added: 0 };
  validateSlug(pageSlug);

  // Re-read the CURRENT page. Skip if it's gone or moved on since the write
  // that triggered us (concurrency guard — the newer write reconciles itself).
  const page = await getPage(storage, pageSlug);
  if (!page || page.content_hash !== expectedContentHash) {
    return { removed: 0, added: 0 };
  }
  const body = page.markdown_body;

  // Malformed-fence guard: markers present but nothing parses → do NOT wipe.
  // Only a genuinely ABSENT fence (no markers) clears the prior projection.
  const hasFenceMarkers = body.includes(FACTS_FENCE_BEGIN);
  const parsed = parseFactsFence(body);
  if (hasFenceMarkers && parsed.length === 0) {
    return { removed: 0, added: 0 };
  }

  // Active rows only: a struck (`~~…~~`) claim is a retraction — it must NOT
  // re-enter the DB index. Dedup by row_num, the fence's stable identity (two
  // rows with the SAME claim but distinct row_num are intentionally distinct
  // facts; the per-page wipe-on-rewrite keeps the row set bounded). Clamp
  // row_num to the INTEGER range and cap the total.
  const seenRow = new Set<number>();
  const facts: { claim: string; confidence: number; source?: string; rowNum: number }[] = [];
  for (const f of parsed) {
    if (!f.active) continue;
    const rowNum = Math.min(Math.max(1, Math.trunc(f.rowNum)), MAX_ROW_NUM);
    if (seenRow.has(rowNum)) continue;
    seenRow.add(rowNum);
    facts.push({ claim: f.claim, confidence: f.confidence, source: f.source, rowNum });
    if (facts.length >= MAX_FACTS_FENCE_ROWS) break;
  }

  const engine: Engine = storage.engine();
  return engine.transaction(async (tx) => {
    const del = await tx.query<{ c: number }>(
      `WITH d AS (
         DELETE FROM entity_facts
          WHERE source_markdown_slug = $1
          RETURNING 1
       )
       SELECT COUNT(*)::int AS c FROM d`,
      [pageSlug],
    );
    let added = 0;
    for (const f of facts) {
      await tx.query(
        `INSERT INTO entity_facts
           (entity_slug, fact, confidence, source_slug, source_chunk_id,
            written_by, source_markdown_slug, row_num)
         VALUES ($1, $2, $3, $4, NULL, $5, $6, $7)`,
        [
          pageSlug,
          f.claim,
          f.confidence,
          safeSourceSlug(f.source),
          FENCE_WRITER,
          pageSlug,
          f.rowNum,
        ],
      );
      added += 1;
    }
    return { removed: del.rows[0]?.c ?? 0, added };
  });
}

/**
 * Purge a page's fence-owned facts (used by page_delete). A soft-deleted page
 * must not keep serving its fence facts; explicit (NULL source_markdown_slug)
 * facts are left intact.
 */
export async function purgeFenceFactsForPage(
  storage: Storage,
  pageSlug: string,
): Promise<{ removed: number }> {
  validateSlug(pageSlug);
  const r = await storage.engine().query<{ c: number }>(
    `WITH d AS (
       DELETE FROM entity_facts WHERE source_markdown_slug = $1 RETURNING 1
     )
     SELECT COUNT(*)::int AS c FROM d`,
    [pageSlug],
  );
  return { removed: r.rows[0]?.c ?? 0 };
}
