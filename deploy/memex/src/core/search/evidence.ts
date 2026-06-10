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
 * `alias_hit` / `exact_title_match` are reserved labels — they only fire once
 * memex grows alias resolution + a title-phrase boost; until then they never
 * surface, and the contract degrades cleanly to the arm-membership signal.
 */

export type Evidence =
  | "alias_hit"
  | "exact_title_match"
  | "high_vector_match"
  | "keyword_exact"
  | "weak_semantic";

export type CreateSafety = "exists" | "probable" | "unknown";

/** Which retrieval arm(s) surfaced a chunk, before RRF fusion. */
export interface ArmMembership {
  inVector: boolean;
  inKeyword: boolean;
}

/**
 * Classify the strongest signal that surfaced a chunk (memex arm-membership).
 *
 * KNOWN LIMITATION of the both-arms→`high_vector_match`→`exists` path: the
 * retrieval fanout is wide, so co-membership in both arms is not the same as a
 * high rank — a common token can land an irrelevant chunk in the keyword arm
 * while the vector arm surfaces it for unrelated reasons, producing a false
 * `exists`. The deferred title-boost / alias work will tighten `exists` by also
 * requiring rank or title agreement; until then this is a deliberately coarse
 * first signal, and `create_safety` stays advisory (the agent re-checks).
 */
export function classifyEvidence(m: ArmMembership): Evidence {
  if (m.inVector && m.inKeyword) return "high_vector_match";
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
  evidence?: Evidence;
  create_safety?: CreateSafety;
}

/**
 * Stamp `evidence` + `create_safety` on every hit in place, from the pre-fusion
 * arm id sets. Idempotent. A chunk in neither set (e.g. injected outside the two
 * arms) classifies as weak_semantic — the safe default.
 */
export function stampEvidence(
  hits: readonly Stampable[],
  vectorIds: ReadonlySet<string>,
  keywordIds: ReadonlySet<string>,
): void {
  for (const h of hits) {
    const evidence = classifyEvidence({
      inVector: vectorIds.has(h.chunkId),
      inKeyword: keywordIds.has(h.chunkId),
    });
    h.evidence = evidence;
    h.create_safety = createSafetyFor(evidence);
  }
}

/**
 * Stamp the conservative default (`weak_semantic` / `unknown`) on hits that
 * have no arm-membership available — the cache-hit path, which hydrates stored
 * chunk ids without re-running retrieval. Keeps the contract UNIFORM (the
 * fields are always present) and conservative (a cached hit reads "look
 * closer", never a false `exists`).
 */
export function stampDefaultEvidence(hits: readonly Stampable[]): void {
  for (const h of hits) {
    h.evidence = "weak_semantic";
    h.create_safety = "unknown";
  }
}
