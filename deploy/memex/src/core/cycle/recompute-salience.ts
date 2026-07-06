/**
 * recompute-salience phase — recompute every live page's `salience` score
 * (migration 036) from its high-emotion tags, graph link-degree, and the
 * density of active synthesis takes attached to it.
 *
 * Deterministic, no LLM. Reads tags from `compiled_truth.tags`, degree from
 * the `links` table (distinct in+out neighbours), and active-take count + avg
 * weight from `synth_takes` (joined to the page via its `page://` mirror
 * document), scores via `computeSalience`, and writes back only the rows whose
 * score changed (an epsilon guard avoids churn from float noise). Idempotent:
 * a brain whose tags, links, and takes are unchanged re-runs to a no-op.
 *
 * Salience drives the standalone "what matters" surface (`memex salience`),
 * NOT the document hybrid-search cache — pages are graph entities, separate
 * from the `documents`/`chunks` the query cache is keyed on — so this phase
 * deliberately does NOT bump the document generation/clock.
 */
import type { Engine } from "../engine/interface.ts";
import { PAGE_MIRROR_PATH_SQL } from "../page-index.ts";
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
  take_count: number | string;
  take_avg_weight: number | string | null;
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
  // Take signal: active (non-rejected) synth_takes attached to a page via its
  // `page://` mirror document (source_ref = documents.id; the mirror's
  // source_path reconstructs from the page's (source_id, slug) via
  // PAGE_MIRROR_PATH_SQL). A page with no mirror or no takes yields 0 count /
  // NULL avg, so the take term stays 0 — link-degree remains the base signal.
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
     ),
     takes AS (
       SELECT p.slug,
              COUNT(t.id) AS take_count,
              AVG(t.weight) AS take_avg_weight
       FROM pages p
       JOIN documents md
         ON md.source_path = ${PAGE_MIRROR_PATH_SQL}
        AND md.deleted_at IS NULL
       JOIN synth_takes t
         ON t.source_ref = md.id
        AND t.status <> 'rejected'
       WHERE p.deleted_at IS NULL
       GROUP BY p.slug
     )
     SELECT p.slug,
            p.compiled_truth,
            COALESCE(d.degree, 0) AS degree,
            COALESCE(tk.take_count, 0) AS take_count,
            tk.take_avg_weight,
            p.salience
     FROM pages p
     LEFT JOIN degrees d ON d.slug = p.slug
     LEFT JOIN takes tk ON tk.slug = p.slug
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
    const takeCount = Number(row.take_count) || 0;
    const takeAvgWeight = Number(row.take_avg_weight) || 0;
    const next = Math.fround(
      computeSalience({ tags, linkDegree: degree, takeCount, takeAvgWeight }, opts),
    );
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
    // salience_touched_at (mig080) stamps only rows whose score CHANGED, so a
    // salience-window consumer can pick up newly-salient old pages without
    // diffing scores. Unchanged pages keep their prior stamp (no churn).
    await engine.query(
      `UPDATE pages AS p
       SET salience = v.salience,
           salience_touched_at = NOW()
       FROM (VALUES ${tuples.join(", ")}) AS v(slug, salience)
       WHERE p.slug = v.slug`,
      params,
    );
  }

  return { scanned: rows.rows.length, updated: changes.length };
}
