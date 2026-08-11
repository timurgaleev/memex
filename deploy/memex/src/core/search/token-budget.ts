/**
 * Token-budget trimming — cap the total size of returned context so an MCP
 * client gets a right-sized result instead of a wall of chunks.
 *
 * Opt-in: callers pass a `tokenBudget`; when unset the full ranked set is
 * returned unchanged. Tokens are estimated as `ceil(chars / 4)` (the usual
 * rough English heuristic) over each hit's `content` — no tokenizer
 * dependency. Hits are consumed in rank order (best first):
 *
 *   - include whole hits while they fit;
 *   - the first hit that would overflow is truncated to the remaining
 *     budget (on a word boundary where possible) with an ellipsis, then
 *     iteration stops;
 *   - at least one hit is always returned, even if it exceeds the budget,
 *     so a tiny budget never yields an empty result.
 */
const CHARS_PER_TOKEN = 4;

export const estTokens = (text: string): number =>
  Math.ceil(text.length / CHARS_PER_TOKEN);

function truncateToTokens(text: string, maxTokens: number): string {
  const maxChars = Math.max(0, maxTokens * CHARS_PER_TOKEN);
  if (text.length <= maxChars) return text;
  const slice = text.slice(0, maxChars);
  // Prefer cutting at the last whitespace so we don't split a word.
  const lastSpace = slice.lastIndexOf(" ");
  const body = lastSpace > maxChars * 0.6 ? slice.slice(0, lastSpace) : slice;
  return `${body.trimEnd()}…`;
}

/** Room left for the body once the title has been charged for. */
function bodyRoom(budget: number, title: string | null | undefined): number {
  return Math.max(1, budget - estTokens(title ?? ""));
}

/**
 * What one hit costs the caller's context window. The title travels with the
 * content on every surface that returns a hit, so charging for the body alone
 * lets the enforced cap overshoot — small per hit, but the cap was asked for as
 * a hard guarantee.
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
    if (out.length === 0) {
      // Always include the top hit; truncate it if it alone blows the budget.
      if (cost <= maxTokens) {
        out.push(hit);
        used = cost;
      } else {
        // Leave room for the title, which ships alongside the body.
        out.push({
          ...hit,
          content: truncateToTokens(hit.content, bodyRoom(maxTokens, hit.title)),
          truncated: true,
        });
        return out;
      }
      continue;
    }
    if (used + cost <= maxTokens) {
      out.push(hit);
      used += cost;
      continue;
    }
    // This hit overflows — truncate it to the remaining budget and stop.
    const remaining = maxTokens - used;
    if (remaining > 0) {
      out.push({
        ...hit,
        content: truncateToTokens(hit.content, bodyRoom(remaining, hit.title)),
        truncated: true,
      });
    }
    break;
  }
  return out;
}
