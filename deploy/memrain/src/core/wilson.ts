/**
 * Wilson score 95% confidence interval for a binomial proportion.
 *
 * A single point estimate (hit-rate = 7/10) hides how little it says at small
 * n. The Wilson interval gives defensible bounds without the normal-approx
 * pathologies at the extremes (it never escapes [0,1], and stays sane at p=0
 * or p=1). Used by `memex eval` to turn a bare recall/hit number into a bounded
 * measurement. Pure, deterministic.
 */

export interface WilsonCI {
  point: number;
  lower: number;
  upper: number;
}

const Z_95 = 1.959963984540054; // standard normal quantile for 95% two-sided

/** Wilson 95% CI for `numerator` successes out of `denominator` trials. */
export function wilsonCI(numerator: number, denominator: number): WilsonCI {
  if (denominator <= 0) return { point: 0, lower: 0, upper: 0 };
  const k = Math.max(0, Math.min(numerator, denominator));
  const n = denominator;
  const p = k / n;
  const z = Z_95;
  const z2 = z * z;
  const center = (p + z2 / (2 * n)) / (1 + z2 / n);
  const margin =
    (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
  // Pin exact boundaries so floating-point residuals (6e-18, 0.9999…) don't
  // leak through: k=0 → lower exactly 0; k=n → upper exactly 1.
  return {
    point: p,
    lower: k === 0 ? 0 : Math.max(0, center - margin),
    upper: k === n ? 1 : Math.min(1, center + margin),
  };
}

/** A note when n is too small for the CI to be actionable (n < 30). */
export function smallSampleNote(n: number): string | undefined {
  if (n >= 30) return undefined;
  return `n=${n} is below 30; the 95% CI is too wide to act on. Run more queries before drawing conclusions.`;
}
