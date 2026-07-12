/**
 * Curation signals over the slug/path prefix — orthogonal to recency decay.
 *
 *  - Curation boost: curated originals outrank bulk feeds INSIDE one store.
 *    A multiplier keyed by slug prefix (authority, not freshness). Neutral
 *    (×1.0) for any path matching no prefix, so it can never bury an
 *    unclassified hit.
 *  - Hard-exclude: never surface fixtures / attachments / raw sidecars. A
 *    prefix denylist applied as a filter. DEFAULT EMPTY — dropping content is
 *    more surprising than reweighting it, so exclusion is opt-in via env;
 *    suggested values are noted below.
 *
 * Both are env-overridable and memoized (parsed once per process). The env
 * parser fails LOUD on a malformed value rather than silently degrading
 * rankings — the throw surfaces the first time the map is resolved.
 *
 * Generic prefixes only — never install-specific names (privacy).
 */

export type CurationBoostMap = Record<string, number>;

/**
 * Authority weights by slug prefix — the full tier map (generic prefixes
 * only, install-specific names stay out for privacy). Curated originals
 * outrank entity pages outrank bulk feeds; archived + machine-extracted
 * content is demoted, never hidden. Fallback (no prefix match) is 1.0.
 */
export const DEFAULT_CURATION_BOOST: CurationBoostMap = {
  // Curated, opinionated, high-signal.
  "originals/": 1.5,
  "writing/": 1.4,
  // Reusable knowledge frameworks.
  "concepts/": 1.3,
  // Entity pages.
  "people/": 1.2,
  "companies/": 1.2,
  "deals/": 1.2,
  // Notes from real meetings.
  "meetings/": 1.1,
  // Ingested third-party content.
  "media/articles/": 1.1,
  "media/repos/": 1.1,
  // Bulk / noisy.
  "daily/": 0.8,
  "media/x/": 0.7,
  // Chat transcripts — massive, noisy, swamp keyword queries.
  "chat/": 0.5,
  // Archived history — findable, ranked below curated (demote-not-exclude).
  "archive/": 0.5,
  // Machine-extracted receipts — never dominate user content.
  "extracts/": 0.3,
};

/** Genuine noise, excluded by default: test fixtures, binary attachments,
 *  raw sidecars. MEMEX_SEARCH_EXCLUDE overrides. */
export const DEFAULT_SEARCH_EXCLUDE: readonly string[] = [
  "test/",
  "attachments/",
  ".raw/",
];

export class CurationParseError extends Error {
  constructor(message: string) {
    super(`MEMEX_CURATION_BOOST: ${message}`);
    this.name = "CurationParseError";
  }
}

let _boostMap: CurationBoostMap | null = null;
let _excludePrefixes: readonly string[] | null = null;

/** Parse `prefix:weight,prefix:weight` — fail loud on a malformed entry. */
function parseBoostEnv(raw: string): CurationBoostMap {
  const map: CurationBoostMap = {};
  for (const part of raw.split(",")) {
    const entry = part.trim();
    if (!entry) continue;
    const colon = entry.lastIndexOf(":");
    if (colon <= 0) throw new CurationParseError(`expected 'prefix:weight' in '${entry}'`);
    const prefix = entry.slice(0, colon);
    const weight = Number(entry.slice(colon + 1));
    if (!Number.isFinite(weight) || weight <= 0) {
      // weight 0 would zero the score — a hard-exclude masquerading as a
      // weight, bypassing the explicit MEMEX_SEARCH_EXCLUDE opt-in. Reject it.
      throw new CurationParseError(`weight must be a positive number in '${entry}'`);
    }
    map[prefix] = weight;
  }
  return map;
}

/** Resolved once per process: env overrides the default map entirely when set. */
export function getCurationBoostMap(): CurationBoostMap {
  if (_boostMap) return _boostMap;
  const raw = (process.env["MEMEX_CURATION_BOOST"] ?? "").trim();
  _boostMap = raw ? parseBoostEnv(raw) : { ...DEFAULT_CURATION_BOOST };
  return _boostMap;
}

/** Resolved once per process: comma-separated prefixes; empty when unset. */
export function getSearchExcludePrefixes(): readonly string[] {
  if (_excludePrefixes) return _excludePrefixes;
  const raw = (process.env["MEMEX_SEARCH_EXCLUDE"] ?? "").trim();
  _excludePrefixes = raw
    ? raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
    : [...DEFAULT_SEARCH_EXCLUDE];
  return _excludePrefixes;
}

/** Longest-prefix-match wins; 1.0 when the path matches no prefix or is null. */
export function curationMultiplierForPath(
  path: string | null | undefined,
  map: CurationBoostMap = getCurationBoostMap(),
): number {
  if (!path) return 1.0;
  let best: { len: number; weight: number } | null = null;
  for (const [prefix, weight] of Object.entries(map)) {
    if (path.startsWith(prefix) && (!best || prefix.length > best.len)) {
      best = { len: prefix.length, weight };
    }
  }
  return best ? best.weight : 1.0;
}

/** True when the path starts with any configured exclude prefix. */
export function isExcludedPath(
  path: string | null | undefined,
  prefixes: readonly string[] = getSearchExcludePrefixes(),
): boolean {
  if (!path || prefixes.length === 0) return false;
  return prefixes.some((p) => path.startsWith(p));
}

/** Test-only: drop memoized env so a test can re-resolve with new env. */
export function _resetCurationForTests(): void {
  _boostMap = null;
  _excludePrefixes = null;
}

// ---------------------------------------------------------------------------
// SQL fragments — the prefix boost is applied INSIDE each retrieval arm's
// ORDER BY so it shapes which rows survive the per-arm LIMIT (a curated hit
// ranking just below the fanout is no longer dropped), and the hard-excludes
// are pushed into the WHERE so noise never eats LIMIT budget.
//
// Raw fragments by design: prefixes come from code defaults or the
// operator's env — both
// LIKE-escaped AND string-escaped before inlining; factors are validated
// finite numbers. The column expression is supplied by the arm, never by
// user input.
// ---------------------------------------------------------------------------

/** Escape `%`, `_`, `\` so a string is a literal LIKE prefix. */
function escapeLikePattern(s: string): string {
  return s.replace(/[%_\\]/g, "\\$&");
}

/** Escape a SQL string literal (single-quote doubling). */
function escapeSqlLiteral(s: string): string {
  return s.replace(/'/g, "''");
}

function likePrefixLiteral(prefix: string): string {
  return `'${escapeSqlLiteral(escapeLikePattern(prefix))}%'`;
}

/**
 * SQL expression normalizing a document source_path for prefix matching:
 * page-mirror docs (`page://<slug>`, `page-truth://<slug>`) shed their scheme
 * so a mirrored `people/x` page matches the same tier as its file twin.
 * `pathColumn` must be an engine-supplied column reference.
 */
export function normalizedPathSql(pathColumn: string): string {
  return (
    `CASE WHEN ${pathColumn} LIKE 'page-truth://%' THEN substr(${pathColumn}, 14) ` +
    `WHEN ${pathColumn} LIKE 'page://%' THEN substr(${pathColumn}, 8) ` +
    `ELSE ${pathColumn} END`
  );
}

/**
 * Build the CASE expression returning the curation factor for a path.
 * Longest-prefix-first so `media/articles/` wins over `media/`. Returns
 * `'1.0'` when the map is empty (or every entry invalid), so callers can
 * multiply unconditionally.
 */
export function buildCurationBoostCaseSql(
  pathColumn: string,
  map: CurationBoostMap = getCurationBoostMap(),
): string {
  const expr = normalizedPathSql(pathColumn);
  const entries = Object.entries(map)
    .filter(([prefix, factor]) => prefix.length > 0 && Number.isFinite(factor) && factor > 0)
    .sort((a, b) => b[0].length - a[0].length);
  if (entries.length === 0) return "1.0";
  const whens = entries
    .map(([prefix, factor]) => `WHEN ${expr} LIKE ${likePrefixLiteral(prefix)} THEN ${factor}`)
    .join(" ");
  return `(CASE ${whens} ELSE 1.0 END)`;
}

/**
 * Build the hard-exclude clause (` AND NOT (path LIKE 'p1%' OR ...)`), or an
 * empty string when no prefixes are configured — callers interpolate
 * unconditionally.
 */
export function buildHardExcludeClauseSql(
  pathColumn: string,
  prefixes: readonly string[] = getSearchExcludePrefixes(),
): string {
  const valid = prefixes.filter((p) => p.length > 0);
  if (valid.length === 0) return "";
  const expr = normalizedPathSql(pathColumn);
  const likes = valid.map((p) => `${expr} LIKE ${likePrefixLiteral(p)}`).join(" OR ");
  return ` AND NOT (${likes})`;
}
