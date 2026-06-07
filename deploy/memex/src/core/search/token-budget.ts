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

const estTokens = (text: string): number =>
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

export function applyTokenBudget<T extends { content: string }>(
  hits: readonly T[],
  maxTokens: number,
): T[] {
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) return [...hits];
  const out: T[] = [];
  let used = 0;
  for (const hit of hits) {
    const cost = estTokens(hit.content);
    if (out.length === 0) {
      // Always include the top hit; truncate it if it alone blows the budget.
      if (cost <= maxTokens) {
        out.push(hit);
        used = cost;
      } else {
        out.push({
          ...hit,
          content: truncateToTokens(hit.content, maxTokens),
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
        content: truncateToTokens(hit.content, remaining),
        truncated: true,
      });
    }
    break;
  }
  return out;
}
