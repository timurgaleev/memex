/**
 * recompute-salience phase — recompute every live page's `salience` score
 * (migration 036) from its high-emotion tags + graph link-degree.
 *
 * Deterministic, no LLM. Reads tags from `compiled_truth.tags` and degree from
 * the `links` table (distinct in+out neighbours), scores via
 * `computeSalience`, and writes back only the rows whose score changed (an
 * epsilon guard avoids churn from float noise). Idempotent: a brain whose tags
 * and links are unchanged re-runs to a no-op.
 *
 * Salience drives the standalone "what matters" surface (`memex salience`),
 * NOT the document hybrid-search cache — pages are graph entities, separate
 * from the `documents`/`chunks` the query cache is keyed on — so this phase
 * deliberately does NOT bump the document generation/clock.
 */
import type { Engine } from "../engine/interface.ts";
import {
  computeSalience,
  parseHighEmotionTagsEnv,
  type SalienceOpts,
} from "../salience-score.ts";

export interface RecomputeSalienceResult {
  scanned: number;
  updated: number;
}

interface PageRow {
  slug: string;
  compiled_truth: Record<string, unknown> | null;
  degree: number | string;
  salience: number | string;
}

/** Float epsilon below which a salience delta is treated as no change. */
const EPSILON = 1e-6;

/**
 * Extract a normalised list of tag strings from a page's compiled_truth.
 * Tolerates a missing field, a JSON-string blob, a single string, or an array
 * with non-string members. Never throws.
 */
export function tagsFromCompiledTruth(truth: unknown): string[] {
  let obj = truth;
  if (typeof obj === "string") {
    try {
      obj = JSON.parse(obj);
    } catch {
      return [];
    }
  }
  if (!obj || typeof obj !== "object") return [];
  const raw = (obj as Record<string, unknown>)["tags"];
  if (typeof raw === "string") {
    return raw.trim().length > 0 ? [raw.trim()] : [];
  }
  if (!Array.isArray(raw)) return [];
  return raw.filter((t): t is string => typeof t === "string" && t.length > 0);
}

export async function recomputeSaliencePhase(
  engine: Engine,
): Promise<RecomputeSalienceResult> {
  // Degree = distinct in+out neighbours per slug, aggregated in one pass.
  // Neighbours are gated to EXISTING, non-deleted pages (JOIN pages np): a
  // dangling/soft target (a `[[wikilink]]` to a not-yet-created page, links.ts
  // soft refs) does NOT count, so a page can't inflate its salience by listing
  // many unresolved references. Connectivity means connectivity to a real
  // entity. When such a target is later created the edge legitimately starts
  // counting.
  //
  // Deliberate tradeoff (reviewers split): gating UNDER-ranks a hub whose
  // outbound references are all still unresolved, but counting ungated edges
  // OVER-ranks link-spam (a page listing 20 nonexistent stubs would saturate
  // the degree boost with zero real connectivity). For a "what matters" signal
  // we favour inflation-safety — unresolved refs resolve over time (reconcile +
  // stub creation) and start counting then.
  const rows = await engine.query<PageRow>(
    `WITH edges AS (
       SELECT source_slug AS slug, target_slug AS neighbour FROM links
       UNION ALL
       SELECT target_slug AS slug, source_slug AS neighbour FROM links
     ),
     degrees AS (
       SELECT e.slug, COUNT(DISTINCT e.neighbour) AS degree
       FROM edges e
       JOIN pages np ON np.slug = e.neighbour AND np.deleted_at IS NULL
       GROUP BY e.slug
     )
     SELECT p.slug,
            p.compiled_truth,
            COALESCE(d.degree, 0) AS degree,
            p.salience
     FROM pages p
     LEFT JOIN degrees d ON d.slug = p.slug
     WHERE p.deleted_at IS NULL`,
  );

  const envTags = parseHighEmotionTagsEnv(process.env["MEMEX_SALIENCE_HIGH_TAGS"]);
  const opts: SalienceOpts = {};
  if (envTags) opts.highEmotionTags = envTags;

  // Collect changed rows, then write them in ONE batched UPDATE … FROM (VALUES)
  // round-trip (atomic, no N+1). `Math.fround` quantises the double to the
  // float4 the `salience` column stores, so the value read back next cycle is
  // bit-identical to what was computed — idempotency is exact, not incidental.
  const changes: Array<{ slug: string; salience: number }> = [];
  for (const row of rows.rows) {
    const tags = tagsFromCompiledTruth(row.compiled_truth);
    const degree = Number(row.degree) || 0;
    const next = Math.fround(computeSalience({ tags, linkDegree: degree }, opts));
    const current = Number(row.salience) || 0;
    if (Math.abs(next - current) > EPSILON) {
      changes.push({ slug: row.slug, salience: next });
    }
  }

  if (changes.length > 0) {
    const params: unknown[] = [];
    const tuples = changes.map((c) => {
      params.push(c.slug, c.salience);
      return `($${params.length - 1}, $${params.length}::real)`;
    });
    await engine.query(
      `UPDATE pages AS p
       SET salience = v.salience
       FROM (VALUES ${tuples.join(", ")}) AS v(slug, salience)
       WHERE p.slug = v.slug`,
      params,
    );
  }

  return { scanned: rows.rows.length, updated: changes.length };
}
