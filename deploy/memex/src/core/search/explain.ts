/**
 * Search `--explain` — per-signal ranking attribution.
 *
 * When a search runs with the opt-in explain flag, hybridSearch records, per
 * surviving chunk, the pre-boost base score (the RRF+cosine fusion result) and
 * the multiplicative factor each post-fusion boost stage contributed, plus the
 * reranker's rank delta. This module owns the shape of that record and its
 * human-readable renderer.
 *
 * Adapted from the reference `search --explain` formatter, mapped onto memex's
 * boost stack (source-boost + recency + salience + curation + title-phrase +
 * backlink + graph-signals + two-pass rerank). A boost is only stamped when it
 * moved the score (factor != 1); a stage that stayed neutral leaves no line, so
 * the breakdown shows exactly which signals fired.
 *
 * Zero cost when off: hybridSearch only allocates the accumulator and takes the
 * per-stage score snapshots inside the `explain` guard, so a normal search
 * neither builds this record nor pays for the before/after diffing.
 */

/**
 * Per-signal attribution for one hit. `base` is the fused RRF (+cosine) score
 * before any multiplicative boost; every `*_boost`-style field is the factor
 * that stage applied (>1 lifted, <1 demoted); `rerank_delta` is the rank change
 * the two-pass reranker made (positive = moved up); `final` is the score the
 * hit was ranked and returned on.
 */
export interface SearchExplain {
  /** Fused RRF (+cosine re-score, when on) score before any boost. */
  base: number;
  /** Source-kind / per-source weight factor (source-boost.ts). */
  source?: number;
  /** Per-prefix recency-decay factor (recency.ts). */
  recency?: number;
  /** Frontmatter pinned/weight salience factor (salience.ts). */
  salience?: number;
  /** Curation-authority-by-prefix factor (curation.ts). */
  curation?: number;
  /** Title-phrase-match factor (title-match.ts). */
  title?: number;
  /** Global in-degree backlink factor (backlink-boost.ts). */
  backlink?: number;
  /** Graph-signals adjacency/session factor (graph-signals.ts). */
  graph?: number;
  /** Two-pass reranker rank change (positive = promoted, negative = demoted). */
  rerank_delta?: number;
  /** Score the hit was ranked/returned on (post all stages). */
  final: number;
}

/** Snapshot every chunk's current score, keyed by chunkId — the "before" for a
 *  boost stage's factor diff. */
export function snapshotScores(
  scored: ReadonlyArray<{ chunkId: string; score: number }>,
): Map<string, number> {
  return new Map(scored.map((s) => [s.chunkId, s.score] as const));
}

/**
 * Diff a boost stage: for each chunk, factor = after / before. Records the
 * factor under `key` only when the stage actually moved the score (|f-1| above
 * a float-noise epsilon), so a neutral stage adds no attribution line. Mutates
 * `acc` in place.
 */
export function recordStageFactor(
  acc: Map<string, Partial<SearchExplain>>,
  before: ReadonlyMap<string, number>,
  scored: ReadonlyArray<{ chunkId: string; score: number }>,
  key: "source" | "backlink" | "graph",
): void {
  for (const s of scored) {
    const b = before.get(s.chunkId);
    if (b === undefined || !(b > 0)) continue;
    const f = s.score / b;
    if (Math.abs(f - 1) <= 1e-9) continue;
    const e = acc.get(s.chunkId) ?? {};
    e[key] = f;
    acc.set(s.chunkId, e);
  }
}

/** Merge a partial factor set into the accumulator for a chunk. */
export function mergeExplain(
  acc: Map<string, Partial<SearchExplain>>,
  chunkId: string,
  patch: Partial<SearchExplain>,
): void {
  acc.set(chunkId, { ...(acc.get(chunkId) ?? {}), ...patch });
}

/**
 * Finalize a chunk's accumulated factors into a complete {@link SearchExplain}.
 * When nothing was accumulated (e.g. an alias-injected hit that never flowed
 * through the boost stages) `base` falls back to `final`, so the record is
 * always well-formed.
 */
export function finalizeExplain(
  partial: Partial<SearchExplain> | undefined,
  finalScore: number,
): SearchExplain {
  return { base: partial?.base ?? finalScore, ...partial, final: finalScore };
}

/** Compact number formatter: 4 dp, trailing zeros trimmed (scores live in the
 *  0.01–0.05 RRF band and the 1.0–1.6 boost band). */
function fmt(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  return n.toFixed(4).replace(/\.?0+$/, "");
}

/**
 * Render one hit's attribution as a multi-line block (no trailing newline).
 * `slug` is a display label (memex passes the source_path). Mirrors the
 * reference layout: a header, the base line, one `+ stage ×factor` line per
 * fired boost, and a closing `= final` line (or `no boosts applied`).
 */
export function formatExplain(
  slug: string,
  explain: SearchExplain,
  rank: number,
): string {
  const lines: string[] = [];
  lines.push(`${rank}. ${slug} (score=${fmt(explain.final)})`);
  lines.push(`   base=${fmt(explain.base)} (rrf+cosine)`);

  let any = false;
  const boost = (label: string, f: number | undefined) => {
    if (f === undefined || f === 1) return;
    any = true;
    const sign = f >= 1 ? "+" : "-";
    lines.push(`   ${sign} ${label} ×${fmt(f)}`);
  };
  boost("source", explain.source);
  boost("recency", explain.recency);
  boost("salience", explain.salience);
  boost("curation", explain.curation);
  boost("title", explain.title);
  boost("backlink", explain.backlink);
  boost("graph", explain.graph);
  if (explain.rerank_delta !== undefined && explain.rerank_delta !== 0) {
    any = true;
    const arrow = explain.rerank_delta > 0 ? "↑" : "↓";
    const sign = explain.rerank_delta > 0 ? "+" : "";
    lines.push(`   ${arrow} reranker rank ${sign}${explain.rerank_delta}`);
  }
  if (!any) lines.push(`   no boosts applied`);
  lines.push(`   = final ${fmt(explain.final)}`);
  return lines.join("\n");
}

/**
 * Render a full hit list's attribution. Each hit must carry an `explain`
 * record and a `sourcePath` label. Returns a single string with a trailing
 * newline (so callers can write it directly); empty list → "No results.\n".
 */
export function formatExplainList(
  hits: ReadonlyArray<{ sourcePath: string; explain?: SearchExplain; score: number }>,
): string {
  if (hits.length === 0) return "No results.\n";
  return (
    hits
      .map((h, i) =>
        formatExplain(h.sourcePath, h.explain ?? { base: h.score, final: h.score }, i + 1),
      )
      .join("\n\n") + "\n"
  );
}
