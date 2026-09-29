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

export function matteringSalienceFactor(
  salience: number,
  strength: "on" | "strong" = "on",
): number {
  if (!Number.isFinite(salience) || salience <= 0) return 1;
  const k = strength === "strong" ? 0.3 : 0.15;
  return 1 + k * Math.log(1 + salience);
}

/**
 * Mattering-salience boost — join the cycle-computed
 * `pages.salience` score (high-emotion tags + link degree + take count, see
 * cycle/recompute-salience.ts) into the hybrid multiplier:
 * `1 + k × ln(1 + salience)`, k = 0.15 ('on') / 0.30 ('strong').
 *
 * Distinct from the frontmatter pinned/weight multiplier above: that is the
 * user's explicit per-document signal; this is the brain's computed "what
 * matters right now" — the hybrid pipeline fires it only when the zero-LLM
 * query classifier suggests salience (meeting prep / catch-up phrasings) and
 * never for canonical queries. Floor-gated like the other metadata boosts.
 *
 * Mutates scores in place; the caller re-sorts and wraps in try/catch
 * (fail-open — a pages lookup error leaves scores intact).
 */
export async function applyMatteringBoost(
  scored: Array<{
    score: number;
    payload?: {
      sourcePath?: string;
      source_id?: string | null;
    };
  }>,
  engine: {
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  opts: {
    strength?: "on" | "strong";
    floorThreshold?: number;
  } = {},
): Promise<void> {
  if (scored.length === 0) return;
  const { slugCandidatesForPath } = await import("./page-slug.ts");
  const perHit = scored.map((s) =>
    slugCandidatesForPath(s.payload?.sourcePath ?? null, s.payload?.source_id ?? null),
  );
  const slugs = [...new Set(perHit.flat())];
  if (slugs.length === 0) return;
  const r = await engine.query<{ slug: string; source_id: string | null; salience: number | string }>(
    `SELECT slug, source_id, salience
       FROM pages
      WHERE slug = ANY($1::text[]) AND deleted_at IS NULL AND salience > 0`,
    [slugs],
  );
  if (r.rows.length === 0) return;
  const byKey = new Map<string, number>();
  for (const row of r.rows) {
    const n = typeof row.salience === "number" ? row.salience : Number(row.salience);
    if (Number.isFinite(n) && n > 0) {
      byKey.set(`${row.source_id ?? "default"}::${row.slug}`, n);
    }
  }
  if (byKey.size === 0) return;
  const strength = opts.strength ?? "on";
  for (let i = 0; i < scored.length; i++) {
    const s = scored[i]!;
    if (!Number.isFinite(s.score)) continue;
    if (opts.floorThreshold !== undefined && s.score < opts.floorThreshold) continue;
    const sid = s.payload?.source_id ?? "default";
    for (const slug of perHit[i]!) {
      const score = byKey.get(`${sid}::${slug}`);
      if (score !== undefined) {
        s.score *= matteringSalienceFactor(score, strength);
        break;
      }
    }
  }
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
