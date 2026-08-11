/**
 * Correcting the type of many pages at once.
 *
 * `pages.type` is load-bearing: it decides which enrichment paths see a page,
 * and it is half of the diary fence. A page that should be `person` but landed
 * as `note` silently drops out of several reads, and until now the only remedy
 * was N individual `page_put` calls — no preview, no rollback, no record.
 *
 * Three decisions here are worth more than the code:
 *
 * 1. **`updated_at` is not touched.** It is behavioural state, not bookkeeping:
 *    the stale-salient anomaly is "a high-salience page whose updated_at has
 *    gone cold" (core/usage-insights.ts), salience rank divides by days since
 *    it, and `get_recent_transcripts` orders by it. Stamping NOW() on a
 *    thousand pages would erase a whole anomaly class and make unrelated pages
 *    look fresh — irreversibly, since the old values are gone.
 *
 * 2. **No `page_versions` row is written.** That table is the BODY history
 *    (body_snapshot, compiled_truth_snapshot); a type change is not a body
 *    edit. Writing one would also mean computing `version_n` from an unlocked
 *    MAX() the way putPage does, which races a concurrent `page_put` into a
 *    primary-key violation. The audit trail goes to `ingest_log` instead — one
 *    row for the whole operation, which is also the right granularity for
 *    "someone retyped 400 pages".
 *
 * 3. **Refusals are evaluated against the rows, not the arguments.** Refusing
 *    `--from diary` does nothing when the same pages are selected by prefix.
 *    The diary fence keys on the TYPE at ~14 call sites, so the check has to
 *    ask what the matched rows actually are.
 */
import type { Engine } from "./engine/interface.ts";
import { logIngest } from "./ingest-log.ts";

/** Types whose pages are hidden from remote callers by the diary fence. */
export const FENCED_TYPES: readonly string[] = ["diary", "journal"];

/** Hard cap on one operation. Large enough to fix a real mistake, small enough
 *  that a mistake is reviewable in a dry run. */
export const RETYPE_MAX_PAGES = 2000;

export interface RetypeSelector {
  /** Only pages currently of this type. */
  from?: string;
  /** Explicit slugs. */
  slugs?: string[];
  /** Slug prefix, e.g. `people/`. */
  pathPrefix?: string;
  /** Tenant scope. */
  sourceId?: string;
}

export interface RetypeMatch {
  slug: string;
  type: string;
}

export interface RetypePlan {
  to: string;
  matches: RetypeMatch[];
  /** Count per current type, so a dry run shows what is about to move. */
  byType: { type: string; count: number }[];
  /** Populated when the plan must not run. */
  refusal: string | null;
}

function normalizeType(t: string): string {
  return t.trim().toLowerCase();
}

/** Build the WHERE clause for a selector. At least one filter is required —
 *  an unfiltered bulk retype is never what someone meant. */
function buildWhere(sel: RetypeSelector): { sql: string; params: unknown[] } | string {
  const where: string[] = ["deleted_at IS NULL"];
  const params: unknown[] = [];
  if (sel.from !== undefined) {
    params.push(normalizeType(sel.from));
    where.push(`type = $${params.length}`);
  }
  if (sel.slugs !== undefined && sel.slugs.length > 0) {
    params.push(sel.slugs);
    where.push(`slug = ANY($${params.length}::text[])`);
  }
  if (sel.pathPrefix !== undefined && sel.pathPrefix.length > 0) {
    params.push(`${sel.pathPrefix.replace(/([%_\\])/g, "\\$1")}%`);
    where.push(`slug LIKE $${params.length}`);
  }
  if (sel.sourceId !== undefined) {
    params.push(sel.sourceId);
    where.push(`source_id = $${params.length}`);
  }
  if (where.length === 1) {
    return "page-retype: give at least one of --from, --slugs or --path-prefix — refusing to retype the whole corpus";
  }
  return { sql: where.join(" AND "), params };
}

/**
 * Work out what would change, and whether it may.
 *
 * Selection and refusal happen together on purpose: the refusal has to see the
 * rows, not the request.
 */
export async function planRetype(
  engine: Engine,
  to: string,
  sel: RetypeSelector,
): Promise<RetypePlan> {
  const target = normalizeType(to);
  const built = buildWhere(sel);
  if (typeof built === "string") {
    return { to: target, matches: [], byType: [], refusal: built };
  }

  const { rows } = await engine.query<{ slug: string; type: string }>(
    `SELECT slug, type FROM pages WHERE ${built.sql} ORDER BY slug LIMIT ${RETYPE_MAX_PAGES + 1}`,
    built.params,
  );
  const matches = rows.slice(0, RETYPE_MAX_PAGES);
  const counts = new Map<string, number>();
  for (const r of matches) counts.set(r.type, (counts.get(r.type) ?? 0) + 1);
  const byType = [...counts]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count);

  let refusal: string | null = null;
  if (rows.length > RETYPE_MAX_PAGES) {
    refusal =
      `page-retype: selection matches more than ${RETYPE_MAX_PAGES} pages — ` +
      `narrow it, so the change stays reviewable`;
  } else if (FENCED_TYPES.includes(target)) {
    // Retyping INTO a fenced type hides pages from every remote caller — and
    // does it inconsistently, since the search mirror is fenced by slug, not
    // type, so the bodies stay readable there. A half-fence reads as protection.
    refusal =
      `page-retype: refusing to retype INTO '${target}' — that hides pages from ` +
      `remote callers while their search mirrors stay visible, which looks like ` +
      `protection and is not`;
  } else {
    // Evaluated on the MATCHED ROWS, never on the arguments: `--from diary` can
    // be sidestepped with --slugs or --path-prefix, and the fence keys on type.
    const fenced = matches.filter((m) => FENCED_TYPES.includes(m.type));
    if (fenced.length > 0) {
      refusal =
        `page-retype: refusing — ${fenced.length} matched page(s) are currently ` +
        `'${fenced[0]!.type}' and are fenced from remote callers by that type ` +
        `(e.g. ${fenced[0]!.slug}). Retyping them would expose them`;
    }
  }

  return { to: target, matches, byType, refusal };
}

export interface RetypeResult {
  updated: number;
  slugs: string[];
}

/**
 * Apply a plan. One statement for the rows, one for the generation clock, one
 * audit row — no per-page round trips holding a single-row lock for the batch.
 */
export async function applyRetype(
  engine: Engine,
  plan: RetypePlan,
  writtenBy: string,
): Promise<RetypeResult> {
  if (plan.refusal !== null) throw new Error(plan.refusal);
  const slugs = plan.matches.map((m) => m.slug);
  if (slugs.length === 0) return { updated: 0, slugs: [] };

  await engine.transaction(async (tx) => {
    // updated_at is deliberately absent — see the module header.
    await tx.query(
      `UPDATE pages SET type = $1, generation = generation + 1
        WHERE slug = ANY($2::text[]) AND deleted_at IS NULL`,
      [plan.to, slugs],
    );
    await tx.query(
      `UPDATE page_generation_clock SET value = value + 1 WHERE id = 1`,
      [],
    );
  });

  // The audit trail for the operation, at the granularity that matters: one
  // row saying someone retyped N pages, not N rows saying a page changed.
  await logIngest(engine, {
    source_type: "page-retype",
    source_ref: plan.to,
    pages_updated: slugs,
    summary: `retyped ${slugs.length} page(s) to '${plan.to}' by ${writtenBy}`,
  });

  return { updated: slugs.length, slugs };
}
