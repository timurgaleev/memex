/**
 * Which pages are allowed to be orphans.
 *
 * An orphan count is only useful if it counts pages that SHOULD have been
 * connected. A brain writes plenty of pages that are islanded by design —
 * synthesis output, drift reports — and once those dominate the number, the
 * number stops being read: 382 orphans reads as noise, gets ignored, and any
 * check built on it fires permanently and gets muted. On the maintainer's brain
 * 283 of 382 were synthesis page mirrors.
 *
 * Exclusion is by PROVENANCE, not by namespace. Excluding `atoms/` and
 * `concepts/` by slug was the obvious shortcut and it is wrong: `page_put`
 * accepts any valid slug, so an authored, genuinely unlinked `concepts/foo`
 * would silently vanish from the very report meant to surface it — hiding a
 * real signal to quiet a noisy count. Every synthesis writer already stamps
 * `page_versions.written_by`, which says what a page IS rather than where it
 * happens to sit.
 *
 * The policy lives here rather than inline at each query, because the same
 * definition has to hold for every surface that reports orphans — a count from
 * one definition and a listing from another is how a finding ends up pointing
 * at something nobody can reproduce.
 *
 * Two env keys, both optional:
 *   MEMEX_ORPHAN_EXCLUDE_WRITERS  replaces the built-in writer list entirely
 *   MEMEX_ORPHAN_EXCLUDE_EXTRA    adds to it
 * Both are comma-separated. PRESENCE decides: `MEMEX_ORPHAN_EXCLUDE_WRITERS=`
 * means count everything.
 */

/**
 * `written_by` values stamped by writers whose pages exist ONLY because the
 * brain made them. Kept in lockstep with the synthesis phases: extract-atoms
 * (synthesis/atoms.ts:479), synthesize-concepts (concepts.ts:301), reflection
 * (reflections.ts:299), patterns (patterns.ts:269), drift (drift.ts:345),
 * auto-think (auto-think.ts:245, the `drafts/think/` pages).
 */
export const DEFAULT_ORPHAN_EXCLUDED_WRITERS: readonly string[] = [
  "extract-atoms",
  "synthesize-concepts",
  "reflection",
  "patterns",
  "drift",
  "auto-think",
];

/**
 * `enrichment` is deliberately NOT in that list, though it is a synthesis
 * writer. enrich-thin does not CREATE pages — it rewrites existing, often
 * authored ones in place (synthesis/enrich-thin.ts:365). Excluding it would
 * make an authored page disappear from the orphan report the moment the brain
 * expanded it, which is the same false negative as excluding by namespace,
 * arrived at from the other direction. The list is for writers whose pages
 * exist only because the brain made them.
 */

function parseCsv(raw: string | undefined): string[] {
  if (typeof raw !== "string") return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** The writers whose pages are not counted as orphans, for this brain. */
export function orphanExcludedWriters(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const replace = env["MEMEX_ORPHAN_EXCLUDE_WRITERS"];
  // PRESENCE decides, not content: a set value — including an empty one — is a
  // deliberate override, and `MEMEX_ORPHAN_EXCLUDE_WRITERS=` is how a brain
  // says "count everything". Testing the length instead would restore the
  // defaults for the plainest way to write that.
  const base =
    replace !== undefined
      ? parseCsv(replace)
      : [...DEFAULT_ORPHAN_EXCLUDED_WRITERS];
  return [...new Set([...base, ...parseCsv(env["MEMEX_ORPHAN_EXCLUDE_EXTRA"])])];
}

/** True when this writer's pages are excluded from orphan reporting. */
export function isExcludedOrphanWriter(
  writtenBy: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (typeof writtenBy !== "string" || writtenBy.length === 0) return false;
  return orphanExcludedWriters(env).includes(writtenBy);
}

/**
 * SQL fragment excluding pages whose CURRENT version was written by one of
 * those writers, plus the parameter it needs.
 *
 * Current version, not "ever": a synthesis page a human later edits becomes
 * their page and should be reported like any other. The newest row is read
 * directly rather than probing every version against a nested max(), so the
 * unbounded advisor count does not walk the whole edit history. `paramIndex`
 * is the 1-based position the writer array will occupy. An empty policy yields
 * an empty fragment, leaving the caller's query untouched.
 */
export function orphanExclusionSql(
  slugColumn: string,
  paramIndex: number,
  env: NodeJS.ProcessEnv = process.env,
): { sql: string; params: unknown[] } {
  const writers = orphanExcludedWriters(env);
  if (writers.length === 0) return { sql: "", params: [] };
  return {
    sql: ` AND COALESCE((
            SELECT pv.written_by FROM page_versions pv
             WHERE pv.slug = ${slugColumn}
             ORDER BY pv.version_n DESC
             LIMIT 1
          ), '') <> ALL($${paramIndex}::text[])`,
    params: [writers],
  };
}
