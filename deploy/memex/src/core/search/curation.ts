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
 * Generic prefixes only — never fork-specific names (privacy).
 */

export type CurationBoostMap = Record<string, number>;

/** Gentle authority weights; fallback (no prefix match) is 1.0. */
export const DEFAULT_CURATION_BOOST: CurationBoostMap = {
  "originals/": 1.3,
  "writing/": 1.2,
  "daily/": 0.9,
  "chat/": 0.7,
  "archive/": 0.6,
};

/** Suggested exclusions for an operator: "test/", "tests/", "attachments/",
 *  ".raw/". Left EMPTY by default — set MEMEX_SEARCH_EXCLUDE to opt in. */
export const DEFAULT_SEARCH_EXCLUDE: readonly string[] = [];

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
