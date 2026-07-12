/**
 * Search mode bundles — conservative / balanced / tokenmax.
 *
 * One env (`MEMEX_SEARCH_MODE`) picks a complete knob set so an operator
 * stops flipping per-knob envs. Resolution chain per knob, later never wins
 * over earlier:
 *
 *   per-call SearchOptions → per-knob env (explicit "1"/"0") → mode bundle
 *
 * DELIBERATE: the default mode is `conservative`, which equals today's
 * defaults — every paid/experimental stage OFF and NO token cap. memex's
 * cost posture is default-OFF; `balanced` (graph + rerank + relational ON,
 * 12000-token cap) and `tokenmax` are one env away.
 *
 * The resolved flag set is folded into the query-cache ranking signature
 * so flipping a mode or knob re-keys the cache instead of serving a stale
 * pre-flip ordering — see query-cache.ts and the suffix hybrid.ts appends
 * for per-call resolved values.
 */

export type SearchMode = "conservative" | "balanced" | "tokenmax";

export const SEARCH_MODES: readonly SearchMode[] = [
  "conservative",
  "balanced",
  "tokenmax",
];

export interface ModeBundle {
  /** LLM query expansion (paid Haiku per search). */
  expansion: boolean;
  /** Two-pass Haiku rerank (paid). */
  rerank: boolean;
  /** Graph-signals post-fusion stage. */
  graphSignals: boolean;
  /** Cosine re-score blend (one embeddings fetch per query). */
  cosineRescore: boolean;
  /** Relational-recall 4th RRF arm. */
  relationalArm: boolean;
  /** Default returned-content token cap; undefined = no cap. */
  tokenBudget: number | undefined;
}

export const MODE_BUNDLES: Readonly<Record<SearchMode, Readonly<ModeBundle>>> =
  Object.freeze({
    // memex's live defaults, unchanged: all optional stages off, no cap.
    conservative: Object.freeze({
      expansion: false,
      rerank: false,
      graphSignals: false,
      cosineRescore: false,
      relationalArm: false,
      tokenBudget: undefined,
    }),
    // The reference's balanced posture mapped onto memex knobs: deterministic
    // + paid-rerank stages on, expansion still off (negligible measured lift),
    // Sonnet-sized token cap.
    balanced: Object.freeze({
      expansion: false,
      rerank: true,
      graphSignals: true,
      cosineRescore: true,
      relationalArm: true,
      tokenBudget: 12_000,
    }),
    // Power-user ceiling: everything on, no cap.
    tokenmax: Object.freeze({
      expansion: true,
      rerank: true,
      graphSignals: true,
      cosineRescore: true,
      relationalArm: true,
      tokenBudget: undefined,
    }),
  });

export const DEFAULT_SEARCH_MODE: SearchMode = "conservative";

export function isSearchMode(x: unknown): x is SearchMode {
  return typeof x === "string" && (SEARCH_MODES as readonly string[]).includes(x);
}

/** Active mode from MEMEX_SEARCH_MODE; unknown/unset → conservative. */
export function resolveSearchMode(
  envValue: string | undefined = process.env["MEMEX_SEARCH_MODE"],
): SearchMode {
  const requested = (envValue ?? "").trim().toLowerCase();
  return isSearchMode(requested) ? requested : DEFAULT_SEARCH_MODE;
}

/** The active mode's bundle. */
export function activeModeBundle(): Readonly<ModeBundle> {
  return MODE_BUNDLES[resolveSearchMode()];
}

/**
 * Resolve one boolean knob: per-call value wins; else an explicit per-knob
 * env "1"/"0" wins; else the mode bundle decides. Any other env value falls
 * through to the bundle (matches the pre-mode `=== "1"` semantics when the
 * bundle default is false).
 */
export function resolveKnob(
  perCall: boolean | undefined,
  envValue: string | undefined,
  bundleValue: boolean,
): boolean {
  if (perCall !== undefined) return perCall;
  if (envValue === "1") return true;
  if (envValue === "0") return false;
  return bundleValue;
}
