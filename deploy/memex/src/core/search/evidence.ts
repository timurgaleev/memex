/**
 * evidence.ts — tell the caller WHY a hit matched, not just a number.
 *
 * Adapted from the reference's evidence/create_safety contract. The reference
 * keys this off a calibrated 0..1 cosine `base_score` (HIGH/SOLID floors).
 * memex has no such score — its hybrid `score` is RRF-fused (rank-based, not a
 * similarity), so those floors are meaningless here. Instead we classify on a
 * signal memex DOES have: which retrieval ARM(s) surfaced the chunk.
 *
 *   - in BOTH the vector AND the keyword arm → both methods independently
 *     surfaced it → the strongest "this is the page" signal.
 *   - keyword arm only → an exact term match, solid but un-corroborated.
 *   - vector arm only → a semantic-only match with no term corroboration; the
 *     weakest signal, and the one most likely to be a near-miss.
 *
 * `create_safety` is the derived "is this page already here?" hint an MCP agent
 * keys its don't-duplicate decision off — conservatively, so a soft signal
 * never reads as "exists" (the failure the reference's contract was built to
 * fix). Pure + deterministic.
 *
 * `exact_title_match` fires when the query is a contiguous phrase in the page
 * title (the title boost). It is arm-independent and the strongest signal here
 * (an author's own phrasing), so it wins regardless of which arm surfaced the
 * chunk. `alias_hit` stays reserved until memex grows alias resolution; until
 * then it never surfaces and the contract degrades cleanly to the title +
 * arm-membership signals.
 */

import { isTitlePhraseMatch } from "./title-match.ts";

export type Evidence =
  | "alias_hit"
  | "exact_title_match"
  | "high_vector_match"
  | "keyword_exact"
  | "weak_semantic";

export type CreateSafety = "exists" | "probable" | "unknown";

/**
 * The both-arms→`high_vector_match`→`exists` path requires the hit to land in
 * the top RANK_BAND results (not rank-0-only). Rationale: rank-0-exclusive
 * needlessly regresses a legitimate page that genuinely sits at rank 1–2 when
 * a few other docs out-rank it (a real "does page X exist?" check would then
 * read `probable` and risk a duplicate). A small band keeps the tightening
 * where it matters — the wide retrieval fanout's long tail, where a common
 * token coincidentally lands junk in both arms — while protecting the head.
 * A title-phrase match still grants `exists` at ANY rank (it short-circuits
 * above), so this band only governs the arm-membership path.
 */
export const RANK_BAND = 3;

/** Which retrieval arm(s) surfaced a chunk, plus the rank/title gate. */
export interface ArmMembership {
  inVector: boolean;
  inKeyword: boolean;
  /** Query is a contiguous phrase in the page title (title boost fired). */
  titleMatch?: boolean;
  /**
   * The chunk is the top-ranked hit after fusion + boosts. Gates the
   * both-arms→`high_vector_match`→`exists` path: see classifyEvidence.
   * Defaults to `true` for the pure-signal classification (callers in the
   * pipeline pass the real rank).
   */
  isTopRank?: boolean;
}

/**
 * Classify the strongest signal that surfaced a chunk.
 *
 * Precedence (strongest wins):
 *   exact_title_match  — query is a phrase in the page title (arm-independent)
 *   high_vector_match  — in BOTH arms AND top-ranked
 *   keyword_exact      — in the keyword arm (exact term match, un-corroborated)
 *   weak_semantic      — vector-only, or neither arm (low-confidence tail)
 *
 * The TOP-RANK gate on `high_vector_match` tightens the prior both-arms→`exists`
 * path: the retrieval fanout is wide, so co-membership in both arms is NOT the
 * same as a high rank — a common token can land an irrelevant chunk in the
 * keyword arm while the vector arm surfaces it for unrelated reasons, producing
 * a false `exists`. Requiring a top-band rank (or a title match, which
 * short-circuits above) means a both-arms hit outside the head degrades to
 * `keyword_exact` (probable) instead of falsely reading `exists`. More
 * conservative — a downgraded hint only makes the agent look closer. The band
 * (vs rank-0-only) protects a legitimate page that sits at rank 1–2; see
 * RANK_BAND.
 */
export function classifyEvidence(m: ArmMembership): Evidence {
  if (m.titleMatch) return "exact_title_match";
  const isTopRank = m.isTopRank ?? true;
  if (m.inVector && m.inKeyword && isTopRank) return "high_vector_match";
  if (m.inKeyword) return "keyword_exact";
  return "weak_semantic";
}

/** Derive the don't-duplicate hint from the evidence (conservative). */
export function createSafetyFor(evidence: Evidence): CreateSafety {
  switch (evidence) {
    case "alias_hit":
    case "exact_title_match":
    case "high_vector_match":
      return "exists";
    case "keyword_exact":
      return "probable";
    case "weak_semantic":
      return "unknown";
  }
}

/** A hit that can be stamped with the evidence contract. */
export interface Stampable {
  chunkId: string;
  title?: string | null;
  evidence?: Evidence;
  create_safety?: CreateSafety;
}

/**
 * Stamp `evidence` + `create_safety` on every hit in place, from the pre-fusion
 * arm id sets + the post-boost rank order. Idempotent. A chunk in neither arm
 * set (e.g. injected outside the two arms) classifies as weak_semantic — the
 * safe default. The first hit (index 0) is the top rank; `query` drives the
 * arm-independent title-phrase match. Pass `query` so a title hit can surface
 * `exact_title_match`; omit it to fall back to pure arm membership.
 */
export function stampEvidence(
  hits: readonly Stampable[],
  vectorIds: ReadonlySet<string>,
  keywordIds: ReadonlySet<string>,
  query?: string,
): void {
  hits.forEach((h, i) => {
    const evidence = classifyEvidence({
      inVector: vectorIds.has(h.chunkId),
      inKeyword: keywordIds.has(h.chunkId),
      titleMatch: query ? isTitlePhraseMatch(query, h.title) : false,
      isTopRank: i < RANK_BAND,
    });
    h.evidence = evidence;
    h.create_safety = createSafetyFor(evidence);
  });
}

/**
 * Stamp evidence on the cache-hit path, which hydrates stored chunk ids without
 * re-running retrieval — so there is NO arm membership to classify. A title
 * match IS still computable (it keys off the query + the hit title, not the
 * arms), so a cached hit on a title-phrase query gets `exact_title_match`;
 * everything else degrades to the conservative default (`weak_semantic` /
 * `unknown`). Keeps the contract UNIFORM (fields always present) and never a
 * false `exists` for an arm-blind hit.
 */
export function stampDefaultEvidence(
  hits: readonly Stampable[],
  query?: string,
): void {
  for (const h of hits) {
    const titleMatch = query ? isTitlePhraseMatch(query, h.title) : false;
    const evidence: Evidence = titleMatch ? "exact_title_match" : "weak_semantic";
    h.evidence = evidence;
    h.create_safety = createSafetyFor(evidence);
  }
}
