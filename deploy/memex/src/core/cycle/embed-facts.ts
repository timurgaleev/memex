/**
 * embed-facts -- backfill semantic embeddings for entity_facts rows whose
 * `embedding` column (migration 038) is still NULL.
 *
 * FALLS-OPEN: each fact is embedded via Bedrock Titan v2 independently; a
 * per-fact failure (Bedrock outage, throttle) is collected and the row is left
 * NULL to retry next cycle -- it never fails the phase or blocks the others.
 * The cycle marks the phase `warn` when any fact errored (same envelope as
 * embed-stale), so a partial Bedrock outage is visible without being fatal.
 *
 * The embed function is injectable (`opts.embed`) so tests run offline with a
 * deterministic stub instead of calling Bedrock.
 *
 * IMMUTABILITY COUPLING: a row is embedded only while its `embedding` is NULL,
 * so the embedding stays correct only because a fact's TEXT never changes in
 * place -- `add_fact` is append-only and the facts-fence reconcile (v1.3.42)
 * REPLACES a page's fence facts (DELETE + INSERT of fresh NULL-embedding rows,
 * which this phase then re-embeds), rather than UPDATE-ing `fact`. If an
 * in-place fact-text edit path is ever added, it MUST also reset `embedding` to
 * NULL so this phase re-embeds it.
 */
import type { Engine } from "../engine/interface.ts";
import { embedText } from "../embedding.ts";

export interface EmbedFactsOptions {
  /** Hard cap on facts embedded per cycle (bounds Bedrock spend). Default 100. */
  maxPerCycle?: number;
  /** Injectable embedder (tests). Defaults to the Bedrock Titan path. */
  embed?: (text: string) => Promise<number[]>;
}

export interface EmbedFactsResult {
  scanned: number;
  embedded: number;
  errors: { id: number; message: string }[];
}

export async function embedFactsPhase(
  engine: Engine,
  opts: EmbedFactsOptions = {},
): Promise<EmbedFactsResult> {
  const maxPerCycle = opts.maxPerCycle ?? 100;
  const embed = opts.embed ?? ((t: string) => embedText(t));

  // btrim, not `<> ''`: embedText rejects whitespace-only input, so a "   "
  // fact would fail every cycle, stay NULL, and starve the LIMIT-bounded slots
  // forever -- skip blank-after-trim rows here instead.
  const rows = await engine.query<{ id: number; fact: string }>(
    `SELECT id, fact
       FROM entity_facts
      WHERE embedding IS NULL AND btrim(fact) <> ''
      ORDER BY written_at DESC
      LIMIT $1`,
    [maxPerCycle],
  );

  const result: EmbedFactsResult = {
    scanned: rows.rows.length,
    embedded: 0,
    errors: [],
  };

  for (const row of rows.rows) {
    try {
      const vec = await embed(row.fact);
      await engine.query(
        `UPDATE entity_facts SET embedding = $1::vector WHERE id = $2`,
        [JSON.stringify(vec), row.id],
      );
      result.embedded += 1;
    } catch (e) {
      result.errors.push({
        id: row.id,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return result;
}
