/**
 * Page salience — a deterministic [0..1] importance score computed from a
 * page's high-emotion tags, graph connectivity (link-degree), and the density
 * of synthesised opinion "takes" attached to it. Pure function, no DB, no LLM.
 * Recomputed by the `recompute-salience` cycle phase and surfaced by the
 * "what matters" salience query (`memex salience`).
 *
 * Link-degree is the base attention signal — the strongest LLM-free "this
 * entity gets a lot of attention" signal — and a small take-density term from
 * the `synth_takes` table (added by synthesis migration 045) folds in on top.
 * The tag-emotion half: tags are an explicit user act of categorisation, so a
 * page tagged `wedding` is *about* something weighty by construction.
 *
 * Formula (sum clamped to [0..1]):
 *   1) Tag-emotion boost   max 0.5  — any high-emotion tag (case-insensitive)
 *   2) Link-degree boost   max 0.5  — ln-scaled in+out degree, saturating (base)
 *   3) Take-density boost  max 0.2  — active takes on the page, additive:
 *      take density (0.05/take, cap 0.15) + avg take weight scaled (max 0.05)
 *
 * A page with no high-emotion tag, no links, and no takes scores exactly 0.0,
 * so the migration-036 default (0.0) survives the formula for an isolated page.
 */

/**
 * Default high-emotion tag seed list. A page carrying any of these tags gets
 * the full tag boost. Anglocentric / personal-life-biased on purpose (the v1
 * default for a personal brain); override at install time via the
 * `MEMEX_SALIENCE_HIGH_TAGS` env var (comma-separated) for a work-first brain.
 */
export const DEFAULT_HIGH_EMOTION_TAGS: ReadonlySet<string> = new Set([
  "family",
  "marriage",
  "wedding",
  "loss",
  "death",
  "grief",
  "relationship",
  "love",
  "mental-health",
  "health",
  "illness",
  "birth",
  "children",
  "kids",
  "parents",
]);

/**
 * Degree at which the link-degree boost saturates to its 0.5 ceiling. A page
 * with this many distinct neighbours is treated as maximally connected.
 * Logarithmic, so the first few links matter most and the curve flattens.
 */
const DEGREE_SATURATION = 20;

const TAG_BOOST_MAX = 0.5;
const DEGREE_BOOST_MAX = 0.5;

/**
 * Take-density term (scaled down so link-degree stays the base signal). Active
 * takes on a page add a small, additive lift capped at TAKE_BOOST_MAX = 0.20:
 *   - density: TAKE_DENSITY_PER (0.05) per active take, capped at 0.15
 *   - avg weight: mean take conviction (0..1) scaled into 0..0.05
 */
const TAKE_DENSITY_PER = 0.05;
const TAKE_DENSITY_MAX = 0.15;
const TAKE_AVG_WEIGHT_MAX = 0.05;

export interface SalienceInput {
  /** Page tags (from compiled_truth.tags). Case-insensitive matched. */
  tags: readonly string[];
  /** Distinct in+out link neighbours of the page. */
  linkDegree: number;
  /**
   * Count of active (non-rejected) `synth_takes` attached to the page via its
   * mirror document. Optional — omitted/0 means no take signal (base formula).
   */
  takeCount?: number;
  /**
   * Mean conviction weight (0..1) across the page's active takes. Optional;
   * only meaningful when {@link takeCount} > 0.
   */
  takeAvgWeight?: number;
}

export interface SalienceOpts {
  /** Override the high-emotion tag set. Matching is case-insensitive. */
  highEmotionTags?: ReadonlySet<string>;
}

/**
 * Parse a comma-separated `MEMEX_SALIENCE_HIGH_TAGS` override into a
 * lowercased set. Empty / unset → null (caller falls back to the default).
 * Tolerant: blank entries are dropped, never throws.
 */
export function parseHighEmotionTagsEnv(
  raw: string | undefined,
): ReadonlySet<string> | null {
  if (!raw) return null;
  const tags = raw
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
  return tags.length > 0 ? new Set(tags) : null;
}

/**
 * Compute a page's salience in [0..1] from its tags + link-degree.
 */
export function computeSalience(
  input: SalienceInput,
  opts: SalienceOpts = {},
): number {
  const tagSet = opts.highEmotionTags ?? DEFAULT_HIGH_EMOTION_TAGS;
  const tags = input.tags ?? [];

  // 1) Tag-emotion boost — case-insensitive + whitespace-trimmed, first match
  //    wins (a stray `" family "` still matches).
  let tagBoost = 0;
  for (const t of tags) {
    if (typeof t === "string" && tagSet.has(t.trim().toLowerCase())) {
      tagBoost = TAG_BOOST_MAX;
      break;
    }
  }

  // 2) Link-degree boost — ln-scaled, saturating at DEGREE_SATURATION.
  const degree =
    Number.isFinite(input.linkDegree) && input.linkDegree > 0
      ? input.linkDegree
      : 0;
  const degreeFrac = Math.min(
    Math.log1p(degree) / Math.log1p(DEGREE_SATURATION),
    1,
  );
  const degreeBoost = degreeFrac * DEGREE_BOOST_MAX;

  // 3) Take-density boost — small additive lift from active takes on the page.
  const takeBoost = computeTakeBoost(input.takeCount, input.takeAvgWeight);

  const total = tagBoost + degreeBoost + takeBoost;
  return Math.max(0, Math.min(1, total));
}

/**
 * Take-density boost in [0..TAKE_BOOST_MAX]. Density (per-take, capped) plus a
 * mean-conviction term. Tolerates missing/NaN/negative inputs as 0.
 */
function computeTakeBoost(
  takeCount: number | undefined,
  takeAvgWeight: number | undefined,
): number {
  const count =
    Number.isFinite(takeCount) && (takeCount as number) > 0
      ? Math.floor(takeCount as number)
      : 0;
  if (count === 0) return 0;

  const density = Math.min(count * TAKE_DENSITY_PER, TAKE_DENSITY_MAX);

  const avg =
    Number.isFinite(takeAvgWeight) && (takeAvgWeight as number) > 0
      ? Math.min(takeAvgWeight as number, 1)
      : 0;
  const avgBoost = avg * TAKE_AVG_WEIGHT_MAX;

  return density + avgBoost;
}
