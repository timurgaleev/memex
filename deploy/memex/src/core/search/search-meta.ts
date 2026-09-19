/**
 * Search meta — what a caller needs to tell "the brain has nothing" from "the
 * search ran degraded". `hybridSearch` reports it through the `onMeta` side
 * channel; the hits array itself never changes shape.
 *
 * The degraded vocabulary is closed on purpose: a reason code is safe to show
 * on public ingress, a count is not (retrieved/returned would turn an empty
 * public result into an existence oracle for chunks the caller cannot see).
 */
import type { Intent } from "./intent.ts";

export const DEGRADED_REASONS = [
  "embed_timeout",
  "vector_arm_failed",
  "keyword_zero",
  "expansion_failed",
  "budget_truncated",
  "rerank_skipped",
] as const;

export type DegradedReason = (typeof DEGRADED_REASONS)[number];

export type SearchCacheState = "hit" | "miss" | "off";

export interface SearchMeta {
  /** A query vector was available, so the vector arm (or a cache built on one) served this call. */
  vectorEnabled: boolean;
  intent: Intent;
  /** The active search mode bundle name. */
  mode: string;
  cache: SearchCacheState;
  degraded: DegradedReason[];
  /** Candidates in the fused pool (or the cached ranked set on a cache hit), before hydrate, dedup and the k trim. */
  retrieved: number;
  returned: number;
}

export interface PublicSearchMeta {
  vectorEnabled: boolean;
  degraded: DegradedReason[];
}

export function publicSearchMeta(meta: SearchMeta): PublicSearchMeta {
  return { vectorEnabled: meta.vectorEnabled, degraded: [...meta.degraded] };
}

const REASON_TEXT: Record<DegradedReason, string> = {
  embed_timeout: "vector arm unavailable (embed_timeout)",
  vector_arm_failed: "vector arm unavailable (vector_arm_failed)",
  keyword_zero: "keyword search found nothing",
  expansion_failed: "query expansion failed",
  budget_truncated: "token budget dropped hits",
  rerank_skipped: "rerank skipped",
};

/** One-line explanation of an empty result, for the CLI's stderr. */
export function formatDegradedNotice(
  meta: Pick<SearchMeta, "degraded" | "vectorEnabled">,
): string {
  if (meta.degraded.length === 0) return "no results";
  const parts = meta.degraded.map((r) =>
    r === "keyword_zero" && !meta.vectorEnabled
      ? "keyword-only search found nothing"
      : REASON_TEXT[r],
  );
  return `no results - ${parts.join("; ")}`;
}
