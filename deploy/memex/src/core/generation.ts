/**
 * Generation clock — cache-invalidation substrate (migration 022).
 *
 * memex uses no DB triggers; callers bump the counters inside their own
 * write transaction. `bumpPageGeneration` is called whenever a page's
 * content changes; `bumpClock` covers writes with no single owning slug
 * (none today — kept for symmetry). `currentClock` is the cheap read the
 * future query cache checks for global staleness.
 */
import type { Engine } from "./engine/interface.ts";

/** Bump a single page's generation AND the global clock, within `tx`. */
export async function bumpPageGeneration(
  tx: Engine,
  slug: string,
): Promise<void> {
  await tx.query(
    `UPDATE pages SET generation = generation + 1 WHERE slug = $1`,
    [slug],
  );
  await bumpClock(tx);
}

/** Bump only the global clock, within `tx`. */
export async function bumpClock(tx: Engine): Promise<void> {
  await tx.query(
    `UPDATE page_generation_clock SET value = value + 1 WHERE id = 1`,
  );
}

/** Current global clock value (0 if unset). */
export async function currentClock(engine: Engine): Promise<number> {
  const r = await engine.query<{ value: number }>(
    `SELECT value FROM page_generation_clock WHERE id = 1`,
  );
  return Number(r.rows[0]?.value ?? 0);
}
