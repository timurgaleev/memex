/**
 * Salience signal — a user-controllable importance multiplier driven by a
 * document's frontmatter, applied as a gentle post-fusion nudge alongside
 * recency.
 *
 * Two frontmatter fields are honoured (both optional):
 *   - `pinned: true`  → the document is important; floor the multiplier at 1.3.
 *   - `weight: <n>`   → explicit multiplier, clamped to [0.5, 2.0].
 *
 * When both are present the larger effect wins. Anything missing / malformed
 * yields 1.0 (neutral), so salience never penalises a document that simply
 * doesn't declare it. This is deterministic and needs no writer / cycle
 * phase — the signal comes straight from data the user already controls.
 */
const MIN = 0.5;
const MAX = 2.0;
const PINNED_FLOOR = 1.3;

const clamp = (n: number): number => Math.min(MAX, Math.max(MIN, n));

function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function isPinned(v: unknown): boolean {
  return v === true || v === "true" || v === 1 || v === "1";
}

export function salienceMultiplier(frontmatter: unknown): number {
  // jsonb is normally returned as a parsed object by postgres-js / PGLite,
  // but tolerate a JSON-string just in case a driver hands one back.
  let fmObj = frontmatter;
  if (typeof fmObj === "string") {
    try {
      fmObj = JSON.parse(fmObj);
    } catch {
      return 1;
    }
  }
  if (!fmObj || typeof fmObj !== "object") return 1;
  const fm = fmObj as Record<string, unknown>;
  let mult = 1;
  const w = asNumber(fm.weight);
  if (w !== null) mult = clamp(w);
  if (isPinned(fm.pinned)) mult = Math.max(mult, PINNED_FLOOR);
  return mult;
}
