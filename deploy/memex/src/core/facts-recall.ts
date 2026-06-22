/**
 * Single-fact recall + forget (soft-delete) over the `entity_facts` ledger.
 *
 * The ledger itself is append-only (see facts.ts), and `entity_facts` is
 * dedup'd per (entity_slug, fact, source_chunk_id). The list/aggregate reads
 * live in facts.ts; this module is the by-id pair:
 *
 *   - `recallFact(id)` — read ONE fact row by its primary key. Returns null
 *     when the id is unknown OR the fact has been forgotten (tombstoned). A
 *     forgotten fact is invisible to recall, mirroring how a soft-deleted page
 *     is invisible to `getPage`.
 *   - `forgetFact(id)` — tombstone a fact by stamping `forgotten_at` (and an
 *     optional `forgotten_reason`). The row stays for audit, exactly like
 *     page soft-delete keeps the page + its version chain. Idempotent: a
 *     second forget on an already-forgotten row is a no-op (forgotten=false),
 *     and an unknown id reports found=false rather than throwing.
 *
 * `forgotten_at` is the tombstone column added by the accompanying migration
 * (ADD COLUMN IF NOT EXISTS, NULLABLE). Append-only writes never touch it; a
 * NULL `forgotten_at` is a live fact.
 *
 * Deterministic and LLM-free.
 */
import type { Storage } from "./storage.ts";

/**
 * A single fact row as returned by `recallFact`. Mirrors the projection in
 * facts.ts `FactRow` plus the `forgotten_at` tombstone column. Always live
 * (recall filters out tombstoned rows), so `forgotten_at` is reported for
 * completeness but is NULL for any row this function returns.
 */
export interface RecalledFact {
  id: number;
  entity_slug: string;
  fact: string;
  confidence: number;
  source_slug: string | null;
  source_chunk_id: string | null;
  written_by: string | null;
  written_at: string;
  kind: string | null;
  notability: string | null;
  valid_from: string | null;
  valid_until: string | null;
  /** Tombstone timestamp; NULL for every live row recall returns. */
  forgotten_at: string | null;
}

function normaliseId(id: unknown): number {
  if (typeof id !== "number" || !Number.isInteger(id) || id < 1) {
    throw new Error("id must be a positive integer");
  }
  return id;
}

/**
 * Read one fact by id. Returns null when the id is unknown or the fact has
 * been forgotten (`forgotten_at IS NOT NULL`) — a tombstoned fact is treated
 * as gone, the same posture `getPage` takes for a soft-deleted page.
 */
export async function recallFact(
  storage: Storage,
  id: number,
): Promise<RecalledFact | null> {
  const factId = normaliseId(id);
  const r = await storage.engine().query<RecalledFact>(
    `SELECT id, entity_slug, fact, confidence,
            source_slug, source_chunk_id, written_by,
            written_at::text AS written_at,
            kind, notability,
            valid_from::text   AS valid_from,
            valid_until::text  AS valid_until,
            forgotten_at::text AS forgotten_at
       FROM entity_facts
       WHERE id = $1 AND forgotten_at IS NULL`,
    [factId],
  );
  return r.rows[0] ?? null;
}

export interface ForgetFactInput {
  /** Optional audit note stored in `forgotten_reason`. */
  reason?: string;
}

export interface ForgetFactResult {
  id: number;
  /** False when no row matched the id. */
  found: boolean;
  /** True only when this call flipped a live fact to forgotten. */
  forgotten: boolean;
}

/**
 * Tombstone a fact by id. Sets `forgotten_at = NOW()` (and `forgotten_reason`
 * when provided) on a live row; the row is retained for audit. Idempotent:
 *   - unknown id          -> { found: false, forgotten: false }
 *   - already-forgotten   -> { found: true,  forgotten: false }
 *   - live -> tombstoned  -> { found: true,  forgotten: true  }
 */
export async function forgetFact(
  storage: Storage,
  id: number,
  input: ForgetFactInput = {},
): Promise<ForgetFactResult> {
  const factId = normaliseId(id);
  const reason = typeof input.reason === "string" ? input.reason : null;
  // Single statement: stamp the tombstone ONLY on a currently-live row. The
  // RETURNING tells us whether this call did the flip; a separate existence
  // probe disambiguates unknown-id from already-forgotten.
  const upd = await storage.engine().query<{ id: number }>(
    `UPDATE entity_facts
        SET forgotten_at = NOW(), forgotten_reason = $2
      WHERE id = $1 AND forgotten_at IS NULL
      RETURNING id`,
    [factId, reason],
  );
  if (upd.rows.length > 0) {
    return { id: factId, found: true, forgotten: true };
  }
  // No flip: either the id is unknown, or it was already forgotten. One cheap
  // existence probe tells the two apart so the caller gets an honest envelope.
  const exists = await storage.engine().query<{ id: number }>(
    `SELECT id FROM entity_facts WHERE id = $1`,
    [factId],
  );
  return {
    id: factId,
    found: exists.rows.length > 0,
    forgotten: false,
  };
}
