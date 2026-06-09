/**
 * Recency signal — a gentle post-fusion multiplier favouring freshly
 * updated content.
 *
 * Operates on the LIVE retrieval model (`documents.updated_at`); the
 * dormant `pages` model is untouched. The multiplier decays exponentially
 * with content age but never below `floor`, so old-but-relevant documents
 * are nudged down, not buried:
 *
 *   multiplier(age) = floor + (1 - floor) * 0.5^(ageDays / halfLifeDays)
 *
 *   age 0          → 1.0
 *   age halfLife   → floor + (1-floor)/2
 *   age → ∞        → floor
 *
 * A missing / unparseable / future timestamp returns 1.0 (neutral), so the
 * signal can never penalise a hit it can't date.
 */
export interface RecencyOptions {
  /** Age at which the decaying part halves. Default 120 days. */
  halfLifeDays?: number;
  /** Lower bound on the multiplier (0..1). Default 0.6. */
  floor?: number;
}

const DAY_MS = 86_400_000;

export function recencyMultiplier(
  updatedAtIso: string | null | undefined,
  nowMs: number,
  opts: RecencyOptions = {},
): number {
  const halfLifeDays = opts.halfLifeDays ?? 120;
  const floor = opts.floor ?? 0.6;
  if (!updatedAtIso) return 1;
  const t = Date.parse(updatedAtIso);
  if (Number.isNaN(t)) return 1;
  const ageDays = (nowMs - t) / DAY_MS;
  if (ageDays <= 0) return 1; // future / just-now → no penalty
  if (halfLifeDays <= 0) return 1; // evergreen — no decay
  const decay = Math.pow(0.5, ageDays / halfLifeDays);
  return floor + (1 - floor) * decay;
}

// ---------------------------------------------------------------------------
// Per-prefix recency decay.
//
// A single global half-life over-penalises evergreen notes (a curated
// concept) and under-penalises time-bound ones (a daily log). The decay
// config is therefore keyed by slug/path prefix, longest-prefix-match wins.
// `halfLifeDays: 0` means evergreen (multiplier always 1.0). Anything that
// matches no prefix uses the fallback, which equals the original uniform
// default — so existing behaviour is preserved for un-prefixed paths
// (e.g. code chunks under `src/`).
//
// Override priority (later wins): DEFAULT_RECENCY_DECAY → env
// (`MEMEX_RECENCY_DECAY=prefix:halfLifeDays:floor,...`). The env parser
// fails LOUD on a malformed value (rather than silently degrading rankings)
// — the throw surfaces the first time the map is resolved (hybrid resolves
// it once, memoized, so a bad value fails the first search after a deploy).
// Prefixes may not contain `:` (the field separator); use `/` namespaces.
// `halfLifeDays: 0` is evergreen and ignores `floor`.
// ---------------------------------------------------------------------------

export type RecencyDecayMap = Record<string, RecencyOptions>;

/** Generic prefixes only — never fork-specific names (privacy). */
export const DEFAULT_RECENCY_DECAY: RecencyDecayMap = {
  "concepts/": { halfLifeDays: 0, floor: 1 }, // evergreen, no decay
  "originals/": { halfLifeDays: 180, floor: 0.7 },
  "writing/": { halfLifeDays: 365, floor: 0.7 },
  "daily/": { halfLifeDays: 14, floor: 0.4 },
  "meetings/": { halfLifeDays: 60, floor: 0.5 },
  "chat/": { halfLifeDays: 7, floor: 0.4 },
  "media/x/": { halfLifeDays: 7, floor: 0.4 },
  "media/articles/": { halfLifeDays: 90, floor: 0.6 },
  "people/": { halfLifeDays: 365, floor: 0.8 },
  "companies/": { halfLifeDays: 365, floor: 0.8 },
  "deals/": { halfLifeDays: 180, floor: 0.7 },
};

/** Applied to paths that match no prefix — equals the original uniform default. */
export const DEFAULT_RECENCY_FALLBACK: RecencyOptions = {
  halfLifeDays: 120,
  floor: 0.6,
};

export class RecencyDecayParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecencyDecayParseError";
  }
}

/**
 * Parse `MEMEX_RECENCY_DECAY`: comma-separated `prefix:halfLifeDays:floor`
 * triples, e.g. `daily/:7:0.4,concepts/:0:1`. Fails loud on a bad value.
 */
export function parseRecencyDecayEnv(env: string | undefined): RecencyDecayMap {
  if (!env) return {};
  const out: RecencyDecayMap = {};
  for (const raw of env.split(",").map((s) => s.trim()).filter(Boolean)) {
    const last = raw.lastIndexOf(":");
    const mid = last > 0 ? raw.lastIndexOf(":", last - 1) : -1;
    if (last <= 0 || mid <= 0) {
      throw new RecencyDecayParseError(
        `MEMEX_RECENCY_DECAY entry ${JSON.stringify(raw)} must be prefix:halfLifeDays:floor`,
      );
    }
    const prefix = raw.slice(0, mid).trim();
    const halfLifeRaw = raw.slice(mid + 1, last).trim();
    const floorRaw = raw.slice(last + 1).trim();
    // Strict numeric: reject trailing junk (parseFloat("7x") would yield 7).
    const NUM = /^\d+(\.\d+)?$/;
    if (!NUM.test(halfLifeRaw) || !NUM.test(floorRaw)) {
      throw new RecencyDecayParseError(
        `non-numeric halfLifeDays/floor in ${JSON.stringify(raw)} (expected prefix:halfLifeDays:floor)`,
      );
    }
    const halfLifeDays = Number.parseFloat(halfLifeRaw);
    const floor = Number.parseFloat(floorRaw);
    if (!prefix) {
      throw new RecencyDecayParseError(`empty prefix in ${JSON.stringify(raw)}`);
    }
    if (!Number.isFinite(halfLifeDays) || halfLifeDays < 0) {
      throw new RecencyDecayParseError(
        `bad halfLifeDays in ${JSON.stringify(raw)} (number >= 0; 0 = evergreen)`,
      );
    }
    if (!Number.isFinite(floor) || floor < 0 || floor > 1) {
      throw new RecencyDecayParseError(
        `bad floor in ${JSON.stringify(raw)} (number in 0..1)`,
      );
    }
    out[prefix] = { halfLifeDays, floor };
  }
  return out;
}

/** Merge defaults + env into the effective decay map (later wins). */
export function resolveRecencyDecayMap(
  envValue: string | undefined = process.env["MEMEX_RECENCY_DECAY"],
): RecencyDecayMap {
  return { ...DEFAULT_RECENCY_DECAY, ...parseRecencyDecayEnv(envValue) };
}

/** Longest-prefix-match the path against the decay map; fallback otherwise. */
export function resolveRecencyConfig(
  path: string | null | undefined,
  map: RecencyDecayMap = DEFAULT_RECENCY_DECAY,
  fallback: RecencyOptions = DEFAULT_RECENCY_FALLBACK,
): RecencyOptions {
  if (!path) return fallback;
  let best: { prefix: string; cfg: RecencyOptions } | null = null;
  for (const [prefix, cfg] of Object.entries(map)) {
    if (
      path.startsWith(prefix) &&
      (!best || prefix.length > best.prefix.length)
    ) {
      best = { prefix, cfg };
    }
  }
  return best ? best.cfg : fallback;
}

/**
 * Recency multiplier for a hit, selecting the per-prefix config from its
 * path. Thin wrapper over `recencyMultiplier` + `resolveRecencyConfig`.
 */
export function recencyMultiplierForPath(
  updatedAtIso: string | null | undefined,
  nowMs: number,
  path: string | null | undefined,
  map: RecencyDecayMap = DEFAULT_RECENCY_DECAY,
  fallback: RecencyOptions = DEFAULT_RECENCY_FALLBACK,
): number {
  return recencyMultiplier(
    updatedAtIso,
    nowMs,
    resolveRecencyConfig(path, map, fallback),
  );
}
