/**
 * Token-budget trimming — cap the total size of returned context so an MCP
 * client gets a right-sized result instead of a wall of chunks.
 *
 * Opt-in: callers pass a `tokenBudget`; when unset the full ranked set is
 * returned unchanged. Tokens are estimated as `ceil(chars / 4)` (the usual
 * rough English heuristic) over each hit's title + content — no tokenizer
 * dependency. Hits are consumed in rank order (best first):
 *
 *   - whole items only — a hit is either returned intact or not at all;
 *   - the first hit that would overflow is dropped and iteration stops, so the
 *     returned set stays a prefix of the ranking;
 *   - a budget too small for even the top hit returns nothing. The caller
 *     asked for a ceiling and gets one.
 *
 * The budget used to truncate the overflowing hit and keep it, charging the
 * body for whatever room the title left. That made the cap a suggestion: a
 * 400-char title under a 50-token budget still shipped the whole title plus a
 * token of body — 102 tokens, twice the cap. Callers report what the cap cost
 * as `input.length - output.length` (hybrid.ts → recordSearchTelemetry), so a
 * dropped hit is visible to the caller rather than silently halved.
 */
const CHARS_PER_TOKEN = 4;

export const estTokens = (text: string): number =>
  Math.ceil(text.length / CHARS_PER_TOKEN);

/**
 * What one hit costs the caller's context window. The title travels with the
 * content on every surface that returns a hit, so charging for the body alone
 * lets the enforced cap overshoot.
 */
function hitCost(hit: { content: string; title?: string | null }): number {
  return estTokens(hit.content) + estTokens(hit.title ?? "");
}

export function applyTokenBudget<T extends { content: string; title?: string | null }>(
  hits: readonly T[],
  maxTokens: number,
): T[] {
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) return [...hits];
  const out: T[] = [];
  let used = 0;
  for (const hit of hits) {
    const cost = hitCost(hit);
    // Rank order is meaningful, so the first hit that does not fit ends the
    // walk: admitting a smaller lower-ranked hit past it would return a set
    // that is no longer the top of the ranking.
    if (used + cost > maxTokens) break;
    out.push(hit);
    used += cost;
  }
  return out;
}
