/**
 * Which pages are allowed to be orphans.
 *
 * An orphan count is only useful if it counts pages that SHOULD have been
 * connected. A brain writes plenty of pages that are islanded by design —
 * synthesis output, drift reports, daily captures — and once those dominate the
 * number, the number stops being read: 379 orphans reads as noise, gets
 * ignored, and any check built on it fires permanently and gets muted.
 *
 * The exclusions live here rather than inline at each query, because the same
 * policy has to hold for every surface that reports orphans — a count from one
 * definition and a listing from another is how a finding ends up pointing at
 * something it does not measure.
 *
 * Two env keys, both optional:
 *   MEMEX_ORPHAN_EXCLUDE_PREFIXES  replaces the built-in list entirely
 *   MEMEX_ORPHAN_EXCLUDE_EXTRA     adds to it
 * Both are comma-separated slug prefixes. Set the first to a single space to
 * turn exclusions off and count every page.
 */

/**
 * Slug prefixes whose pages are orphaned on purpose. Kept in lockstep with the
 * prefixes the synthesis phases write (see reflections.ts / patterns.ts /
 * drift.ts) and the anti-loop filters those phases already apply to their own
 * inputs.
 */
export const DEFAULT_ORPHAN_EXCLUDED_PREFIXES: readonly string[] = [
  "reflections/",
  "patterns/",
  "drafts/",
  "drift-reports/",
  "wiki/agents/",
  "reports/",
];

function parseCsv(raw: string | undefined): string[] {
  if (typeof raw !== "string") return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** The prefixes in force for this brain. */
export function orphanExcludedPrefixes(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const replace = env["MEMEX_ORPHAN_EXCLUDE_PREFIXES"];
  // PRESENCE decides, not content: a set value — including an empty one — is a
  // deliberate override, and `MEMEX_ORPHAN_EXCLUDE_PREFIXES=` is how a brain
  // says "count everything". Testing the length instead would restore the
  // defaults for the plainest way to write that, leaving a whitespace string as
  // the only workaround — an accident, not a contract.
  const base =
    replace !== undefined
      ? parseCsv(replace)
      : [...DEFAULT_ORPHAN_EXCLUDED_PREFIXES];
  const extra = parseCsv(env["MEMEX_ORPHAN_EXCLUDE_EXTRA"]);
  return [...new Set([...base, ...extra])];
}

/** True when this slug is orphaned by design and should not be counted. */
export function isExcludedFromOrphans(
  slug: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return orphanExcludedPrefixes(env).some((p) => slug.startsWith(p));
}

/**
 * SQL fragment excluding those prefixes, plus the parameter it needs.
 *
 * `paramIndex` is the 1-based position the LIKE-pattern array will occupy.
 * Returns an empty fragment (and no param) when nothing is excluded, so the
 * caller's query is unchanged in that case.
 */
export function orphanExclusionSql(
  columnRef: string,
  paramIndex: number,
  env: NodeJS.ProcessEnv = process.env,
): { sql: string; params: unknown[] } {
  const prefixes = orphanExcludedPrefixes(env);
  if (prefixes.length === 0) return { sql: "", params: [] };
  // Escape the LIKE metacharacters in the prefix itself — a slug prefix is a
  // literal, and an underscore in one would otherwise match any character.
  const patterns = orphanExclusionPatterns(env);
  return {
    sql: ` AND NOT (${columnRef} LIKE ANY($${paramIndex}::text[]))`,
    params: [patterns],
  };
}

/** The LIKE patterns themselves, for a caller building its own SQL. */
export function orphanExclusionPatterns(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return orphanExcludedPrefixes(env).map(
    (p) => `${p.replace(/([%_\\])/g, "\\$1")}%`,
  );
}
